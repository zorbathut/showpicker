"""Showpicker: type in some movie/series names, get title cards and stills to show people.

Data sources: Jellyfin (the user's library; images proxied through us so the browser never sees the key) and optionally TMDB (anything else, plus extra artwork for library titles).
"""

import asyncio
import logging
import os
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import assert_never

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from app.config import Config, ErrorConfig, config_from_env
from app.jellyfin import JF_IMAGE_TYPES, Jellyfin
from app.redact import describe
from app.title import JF_ID_RE, ErrorTitleKey, TitleDraft, TitleKeyJellyfin, TitleKeyTmdb, title_key_parse
from app.tmdb import Tmdb

log = logging.getLogger("showpicker")

STATIC = Path(__file__).parent / "static"
UPSTREAM_TIMEOUT_S = 20
CACHE_TTL_S = 3600
CACHE_DEGRADED_TTL_S = 60  # a title whose artwork partly failed is retried soon rather than served degraded for an hour
CACHE_MAX_ENTRIES = 5000
IMAGE_MIN_W = 64
IMAGE_MAX_W = 3840
IMAGE_CACHE_HEADER = "public, max-age=604800"
SEARCH_QUERY_MAX = 200
LINEUP_MAX = 50
HIDDEN_MAX = 2000
HIDDEN_IMAGE_MAX_LEN = 1000


class LineupPut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_instance: str
    base_version: int
    keys: list[str]


class HiddenPost(BaseModel):
    """Hide or unhide one picture of a title; `image: null` with `hidden: false` unhides all of that title's pictures."""

    model_config = ConfigDict(extra="forbid")

    key: str
    image: str | None
    hidden: bool


def lineup_problem(keys: list[str]) -> str | None:
    """Why this lineup can't be stored, as a message for the user; None if it's fine."""
    if len(keys) > LINEUP_MAX:
        return f"Lineup is full ({LINEUP_MAX} titles max)"
    if len(set(keys)) != len(keys):
        return "Lineup contains the same title twice"
    for key in keys:
        try:
            title_key_parse(key)
        except ErrorTitleKey as e:
            return str(e)
    return None


def app_create(config: Config, transport: httpx.AsyncBaseTransport | None, clock: Callable[[], float]) -> FastAPI:
    """`transport` replaces the network for every upstream request (tests pass an httpx.MockTransport); None uses the real network. `clock` returns seconds, like time.time."""
    client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S, follow_redirects=True, transport=transport)
    jf = Jellyfin(config.jellyfin, client) if config.jellyfin else None
    tmdb = Tmdb(config.tmdb_key, client) if config.tmdb_key else None
    secrets = config.secrets()
    cache: dict[str, tuple[float, dict]] = {}
    # `instance` changes whenever the server restarts, so clients can tell a fresh (empty) lineup from an old version of the one they had.
    lineup = {"instance": uuid.uuid4().hex, "version": 0, "keys": []}
    # Pictures hidden as spoilers, per title key, by image id (the picture's `full` URL). Versioned separately from the lineup so hiding never makes a lineup edit conflict. Ids come from clients: only ever compared, never rendered.
    hidden: dict[str, list[str]] = {}
    hidden_state = {"version": 0}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        log.info("Jellyfin: %s | TMDB: %s", config.jellyfin.url if config.jellyfin else "disabled", "enabled" if tmdb else "disabled")
        yield
        await client.aclose()

    app = FastAPI(title="Showpicker", lifespan=lifespan)

    async def tmdb_top_up(draft: TitleDraft) -> None:
        """Library artwork usually came from TMDB in the first place, so mixing both sets shows duplicates: use TMDB's backdrops instead of the library's when TMDB has at least as many."""
        media = "tv" if draft.kind == "series" else "movie"
        try:
            logo, backdrops = await tmdb.images(media, draft.tmdb_id)
        except httpx.HTTPError as e:
            log.warning("TMDB artwork for %s (tmdb %s) failed, using library artwork only: %s", draft.key, draft.tmdb_id, describe(e, secrets))
            draft.degraded = True
            return
        if len(backdrops) >= len(draft.backdrops):
            draft.backdrops = backdrops
        if not draft.info.logo:
            draft.info.logo = logo

    async def title_details(key: str) -> TitleDraft:
        try:
            parsed = title_key_parse(key)
        except ErrorTitleKey as e:
            raise HTTPException(400, str(e)) from e
        match parsed:
            case TitleKeyJellyfin(item_id):
                if not jf:
                    raise HTTPException(404, "Jellyfin is not configured on this server")
                draft = await jf.details(item_id)
                if draft and tmdb and draft.tmdb_id:
                    await tmdb_top_up(draft)
            case TitleKeyTmdb(media, tmdb_id):
                if not tmdb:
                    raise HTTPException(404, "TMDB is not configured on this server")
                draft = await tmdb.details(media, tmdb_id)
            case _:
                assert_never(parsed)
        if draft is None:
            raise HTTPException(404, f"No such title: {key}")
        return draft

    @app.get("/api/config")
    async def api_config():
        return {"jellyfin": jf is not None, "tmdb": tmdb is not None, "lineup_max": LINEUP_MAX}

    @app.get("/api/search")
    async def api_search(q: str = Query(min_length=1, max_length=SEARCH_QUERY_MAX)):
        sources = [(name, src) for name, src in (("Jellyfin", jf), ("TMDB", tmdb)) if src]
        responses = await asyncio.gather(*(src.search(q) for _, src in sources), return_exceptions=True)
        results, errors, seen = [], [], set()
        for (name, _), res in zip(sources, responses, strict=True):
            if isinstance(res, BaseException):
                if isinstance(res, httpx.HTTPError):
                    log.warning("%s search failed: %s", name, describe(res, secrets))
                else:
                    log.error("%s search failed", name, exc_info=res)
                errors.append(f"{name} search failed: {describe(res, secrets)}")
                continue
            for hit in res:
                # Hide TMDB hits that duplicate something already in the library.
                sig = ((hit.title or "").casefold(), hit.year, hit.kind)
                if sig in seen:
                    continue
                seen.add(sig)
                results.append(hit.payload())
        return {"results": results, "errors": errors}

    @app.get("/api/title/{key:path}")
    async def api_title(key: str):
        cached = cache.get(key)
        if cached and cached[0] > clock():
            return cached[1]
        try:
            draft = await title_details(key)
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"Upstream error: HTTP {e.response.status_code}") from e
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Upstream error: {describe(e, secrets)}") from e
        payload = draft.payload()
        if len(cache) >= CACHE_MAX_ENTRIES:
            cache.clear()
        cache[key] = (clock() + (CACHE_DEGRADED_TTL_S if draft.degraded else CACHE_TTL_S), payload)
        return payload

    def hidden_payload() -> dict:
        return {"instance": lineup["instance"], "hidden_version": hidden_state["version"], "hidden": hidden}

    @app.get("/api/lineup")
    async def api_lineup_get():
        return {**lineup, **hidden_payload()}

    @app.post("/api/hidden")
    async def api_hidden_post(body: HiddenPost):
        try:
            title_key_parse(body.key)
        except ErrorTitleKey as e:
            raise HTTPException(400, str(e)) from e
        if body.image is None:
            if body.hidden:
                raise HTTPException(400, "Name the picture to hide")
            changed = hidden.pop(body.key, None) is not None
        else:
            if not body.image or len(body.image) > HIDDEN_IMAGE_MAX_LEN:
                raise HTTPException(400, f"Picture id must be 1-{HIDDEN_IMAGE_MAX_LEN} characters")
            pictures = hidden.get(body.key, [])
            present = body.image in pictures
            if body.hidden and not present:
                if sum(len(v) for v in hidden.values()) >= HIDDEN_MAX:
                    raise HTTPException(400, f"Too many hidden pictures ({HIDDEN_MAX} max); unhide some first")
                hidden[body.key] = [*pictures, body.image]
            elif not body.hidden and present:
                remaining = [p for p in pictures if p != body.image]
                if remaining:
                    hidden[body.key] = remaining
                else:
                    del hidden[body.key]
            changed = body.hidden != present
        if changed:
            hidden_state["version"] += 1
        return hidden_payload()

    @app.put("/api/lineup")
    async def api_lineup_put(body: LineupPut):
        problem = lineup_problem(body.keys)
        if problem:
            raise HTTPException(400, problem)
        # No await between this check and the write, so it's atomic on the event loop.
        if (body.base_instance, body.base_version) != (lineup["instance"], lineup["version"]):
            return JSONResponse(lineup, status_code=409)
        lineup["version"] += 1
        lineup["keys"] = body.keys
        return lineup

    @app.get("/img/jf/{item_id}/{kind}")
    @app.get("/img/jf/{item_id}/{kind}/{index}")
    async def img_jf(item_id: str, kind: str, w: int, index: int | None = None, tag: str | None = None):
        if not jf:
            raise HTTPException(404, "Jellyfin is not configured on this server")
        if not JF_ID_RE.match(item_id) or kind not in JF_IMAGE_TYPES:
            raise HTTPException(404, "No such image")
        try:
            r = await jf.image(item_id, kind, index, min(max(w, IMAGE_MIN_W), IMAGE_MAX_W), tag)
        except httpx.HTTPError as e:
            raise HTTPException(502, describe(e, secrets)) from e
        if r.status_code == 404:
            raise HTTPException(404, "No such image")
        if r.status_code != 200:
            raise HTTPException(502, f"Upstream error: HTTP {r.status_code}")
        return Response(r.content, media_type=r.headers["content-type"], headers={"Cache-Control": IMAGE_CACHE_HEADER})

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def app_from_env() -> FastAPI:
    """Entry point for `uvicorn --factory`."""
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs request URLs at INFO, which can contain the TMDB api_key
    try:
        config = config_from_env(os.environ)
    except ErrorConfig as e:
        log.critical("Configuration error: %s", e)
        raise SystemExit(1) from e
    return app_create(config, None, time.time)
