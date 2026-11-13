"""Showpicker: type in some movie/series names, get title cards + stills to show people.

Data sources:
  * Jellyfin (JELLYFIN_URL + JELLYFIN_API_KEY) - your own library, images proxied through us.
  * TMDB (TMDB_API_KEY, optional) - anything not in the library, and extra art for library items.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("showpicker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logging.getLogger("httpx").setLevel(logging.WARNING)  # its URLs can contain the TMDB api_key

JF_URL = os.environ.get("JELLYFIN_URL", "").strip().rstrip("/")
JF_KEY = os.environ.get("JELLYFIN_API_KEY", "").strip()
JF_USER = os.environ.get("JELLYFIN_USER_ID", "").strip()
TMDB_KEY = os.environ.get("TMDB_API_KEY", "").strip()

JF_ENABLED = bool(JF_URL and JF_KEY)
TMDB_ENABLED = bool(TMDB_KEY)

TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p"
STATIC = Path(__file__).parent / "static"

MAX_BACKDROPS = 8
MAX_STILLS = 6

JF_HEADERS = {
    "Authorization": (
        'MediaBrowser Client="Showpicker", Device="Showpicker", '
        f'DeviceId="showpicker", Version="1.0", Token="{JF_KEY}"'
    ),
    "Accept": "application/json",
}

JF_ID_RE = re.compile(r"^[0-9a-fA-F-]{32,36}$")
JF_IMAGE_TYPES = {"Primary", "Backdrop", "Logo", "Thumb", "Chapter"}

client: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global client
    client = httpx.AsyncClient(timeout=20, follow_redirects=True)
    log.info("Jellyfin: %s | TMDB: %s",
             JF_URL if JF_ENABLED else "disabled",
             "enabled" if TMDB_ENABLED else "disabled")
    yield
    await client.aclose()


app = FastAPI(title="Showpicker", lifespan=lifespan)

# --------------------------------------------------------------------------- cache

_cache: dict[str, tuple[float, object]] = {}


def cache_get(key: str):
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def cache_put(key: str, value, ttl: int = 3600):
    if len(_cache) > 5000:
        _cache.clear()
    _cache[key] = (time.time() + ttl, value)


# --------------------------------------------------------------------------- helpers


def spread(seq: list, n: int) -> list:
    """Pick n items evenly spaced through seq (keeps first and last)."""
    if len(seq) <= n:
        return list(seq)
    if n == 1:
        return [seq[0]]
    return [seq[round(i * (len(seq) - 1) / (n - 1))] for i in range(n)]


def describe(e: BaseException) -> str:
    """Error text safe to log/show: httpx messages embed request URLs, which can carry keys."""
    if isinstance(e, httpx.HTTPStatusError):
        msg = f"HTTP {e.response.status_code}"
    else:
        msg = str(e) or type(e).__name__
    for secret in (TMDB_KEY, JF_KEY):
        if secret:
            msg = msg.replace(secret, "***")
    return msg


def pic(full: str, thumb: str) -> dict:
    return {"full": full, "thumb": thumb}


def year_of(date: str | None) -> int | None:
    if date and len(date) >= 4 and date[:4].isdigit():
        return int(date[:4])
    return None


def blank_title(key: str, source: str, kind: str) -> dict:
    return {
        "key": key, "source": source, "kind": kind,
        "title": None, "year": None, "end_year": None, "status": None,
        "tagline": None, "overview": None, "genres": [], "rating": None,
        "certification": None, "runtime": None, "seasons": None,
        "logo": None, "poster": None, "backdrops": [], "stills": [],
    }


# --------------------------------------------------------------------------- Jellyfin

_jf_uid: str | None = JF_USER or None


async def jf_get(path: str, **params):
    r = await client.get(JF_URL + path, params=params, headers=JF_HEADERS)
    r.raise_for_status()
    return r.json()


async def jf_user() -> str:
    """API keys aren't tied to a user, but item queries want one; use the first admin."""
    global _jf_uid
    if not _jf_uid:
        users = await jf_get("/Users")
        if not users:
            raise RuntimeError("Jellyfin returned no users")
        admins = [u for u in users if (u.get("Policy") or {}).get("IsAdministrator")]
        _jf_uid = (admins or users)[0]["Id"]
    return _jf_uid


def jf_img(item_id: str, kind: str, index: int | None = None,
           tag: str | None = None, width: int = 1920) -> str:
    path = f"/img/jf/{item_id}/{kind}" + (f"/{index}" if index is not None else "")
    return path + f"?w={width}" + (f"&tag={tag}" if tag else "")


async def jf_search(q: str) -> list[dict]:
    uid = await jf_user()
    data = await jf_get(
        "/Items", userId=uid, searchTerm=q, IncludeItemTypes="Movie,Series",
        Recursive="true", Limit=8, Fields="ProductionYear",
    )
    out = []
    for it in data.get("Items") or []:
        tag = (it.get("ImageTags") or {}).get("Primary")
        out.append({
            "key": f"jf:{it['Id']}",
            "source": "jellyfin",
            "title": it.get("Name"),
            "year": it.get("ProductionYear"),
            "kind": "series" if it.get("Type") == "Series" else "movie",
            "poster": jf_img(it["Id"], "Primary", tag=tag, width=120) if tag else None,
        })
    return out


async def jf_episode_stills(uid: str, series_id: str) -> list[dict]:
    """Stills from early episodes (season 1-ish, no specials) to keep spoilers down."""
    data = await jf_get(
        "/Items", userId=uid, ParentId=series_id, IncludeItemTypes="Episode",
        Recursive="true", SortBy="ParentIndexNumber,IndexNumber", Limit=60,
        ImageTypes="Primary", Fields="ParentIndexNumber",
    )
    eps = [e for e in data.get("Items") or []
           if (e.get("ParentIndexNumber") or 0) != 0 and (e.get("ImageTags") or {}).get("Primary")]
    eps = eps[:12]
    return [
        pic(jf_img(e["Id"], "Primary", tag=e["ImageTags"]["Primary"], width=1920),
            jf_img(e["Id"], "Primary", tag=e["ImageTags"]["Primary"], width=640))
        for e in spread(eps, MAX_STILLS)
    ]


async def jf_details(item_id: str) -> dict:
    uid = await jf_user()
    data = await jf_get(
        "/Items", userId=uid, ids=item_id,
        Fields="Overview,Genres,ProductionYear,Chapters,OfficialRating,CommunityRating,"
               "RunTimeTicks,Taglines,ChildCount,ProviderIds,Status,EndDate",
    )
    items = data.get("Items") or []
    if not items:
        raise HTTPException(404, "Not found in Jellyfin")
    it = items[0]
    iid = it["Id"]
    tags = it.get("ImageTags") or {}
    series = it.get("Type") == "Series"

    d = blank_title(f"jf:{iid}", "jellyfin", "series" if series else "movie")
    d.update({
        "title": it.get("Name"),
        "year": it.get("ProductionYear"),
        "end_year": year_of(it.get("EndDate")),
        "status": it.get("Status"),
        "tagline": (it.get("Taglines") or [None])[0],
        "overview": it.get("Overview"),
        "genres": it.get("Genres") or [],
        "rating": round(it["CommunityRating"], 1) if it.get("CommunityRating") else None,
        "certification": it.get("OfficialRating"),
        "runtime": round(it["RunTimeTicks"] / 600_000_000) if it.get("RunTimeTicks") else None,
        "seasons": it.get("ChildCount") if series else None,
    })
    if "Logo" in tags:
        d["logo"] = jf_img(iid, "Logo", tag=tags["Logo"], width=1000)
    if "Primary" in tags:
        d["poster"] = jf_img(iid, "Primary", tag=tags["Primary"], width=600)
    d["backdrops"] = [
        pic(jf_img(iid, "Backdrop", i, t, 1920), jf_img(iid, "Backdrop", i, t, 640))
        for i, t in enumerate(it.get("BackdropImageTags") or [])
    ][:MAX_BACKDROPS]

    if series:
        try:
            d["stills"] = await jf_episode_stills(uid, iid)
        except httpx.HTTPError as e:
            log.warning("episode stills failed for %s: %s", iid, describe(e))
    else:
        chapters = [(i, c) for i, c in enumerate(it.get("Chapters") or []) if c.get("ImageTag")]
        if len(chapters) > 2:
            chapters = chapters[1:]  # chapter 0 is usually studio logos / black
        chapters = chapters[: max(1, int(len(chapters) * 0.6))]  # stay out of the ending
        d["stills"] = [
            pic(jf_img(iid, "Chapter", i, c["ImageTag"], 1920), jf_img(iid, "Chapter", i, c["ImageTag"], 640))
            for i, c in spread(chapters, MAX_STILLS)
        ]

    # Library items often have just one backdrop; top up from TMDB when we can.
    tmdb_id = (it.get("ProviderIds") or {}).get("Tmdb")
    if TMDB_ENABLED and tmdb_id and (len(d["backdrops"]) < 4 or not d["logo"]):
        try:
            extra = await tmdb_images("tv" if series else "movie", tmdb_id)
            d["logo"] = d["logo"] or extra["logo"]
            d["backdrops"] = (d["backdrops"] + extra["backdrops"])[:MAX_BACKDROPS]
        except httpx.HTTPError as e:
            log.warning("TMDB top-up failed for %s: %s", tmdb_id, describe(e))
    return d


# --------------------------------------------------------------------------- TMDB


async def tmdb_get(path: str, **params):
    headers = {"Accept": "application/json"}
    if TMDB_KEY.startswith("eyJ"):  # v4 read access token
        headers["Authorization"] = f"Bearer {TMDB_KEY}"
    else:  # v3 api key
        params["api_key"] = TMDB_KEY
    r = await client.get(TMDB_API + path, params=params, headers=headers)
    r.raise_for_status()
    return r.json()


async def tmdb_search(q: str) -> list[dict]:
    data = await tmdb_get("/search/multi", query=q, include_adult="false", language="en-US")
    out = []
    for r in data.get("results") or []:
        mt = r.get("media_type")
        if mt not in ("movie", "tv"):
            continue
        out.append({
            "key": f"tmdb:{mt}:{r['id']}",
            "source": "tmdb",
            "title": r.get("title") or r.get("name"),
            "year": year_of(r.get("release_date") or r.get("first_air_date")),
            "kind": "series" if mt == "tv" else "movie",
            "poster": f"{TMDB_IMG}/w154{r['poster_path']}" if r.get("poster_path") else None,
        })
        if len(out) >= 8:
            break
    return out


def tmdb_pick_images(images: dict) -> dict:
    logos = sorted(images.get("logos") or [],
                   key=lambda l: (l.get("iso_639_1") != "en", -(l.get("vote_average") or 0)))
    # Textless backdrops first (no baked-in title), then by votes.
    bds = sorted(images.get("backdrops") or [],
                 key=lambda b: (b.get("iso_639_1") is not None, -(b.get("vote_average") or 0)))
    return {
        "logo": f"{TMDB_IMG}/w500{logos[0]['file_path']}" if logos else None,
        "backdrops": [pic(f"{TMDB_IMG}/original{b['file_path']}", f"{TMDB_IMG}/w780{b['file_path']}")
                      for b in bds[:MAX_BACKDROPS]],
    }


async def tmdb_images(mt: str, tmdb_id: str | int) -> dict:
    data = await tmdb_get(f"/{mt}/{tmdb_id}/images", include_image_language="en,null")
    return tmdb_pick_images(data)


async def tmdb_details(mt: str, tmdb_id: str) -> dict:
    data = await tmdb_get(f"/{mt}/{tmdb_id}", append_to_response="images",
                          include_image_language="en,null", language="en-US")
    series = mt == "tv"
    d = blank_title(f"tmdb:{mt}:{tmdb_id}", "tmdb", "series" if series else "movie")
    runtime = data.get("runtime") if not series else (data.get("episode_run_time") or [None])[0]
    d.update({
        "title": data.get("title") or data.get("name"),
        "year": year_of(data.get("release_date") or data.get("first_air_date")),
        "end_year": year_of(data.get("last_air_date")) if series and data.get("status") == "Ended" else None,
        "status": data.get("status"),
        "tagline": data.get("tagline") or None,
        "overview": data.get("overview"),
        "genres": [g["name"] for g in data.get("genres") or []],
        "rating": round(data["vote_average"], 1) if data.get("vote_average") else None,
        "runtime": runtime,
        "seasons": data.get("number_of_seasons") if series else None,
        "poster": f"{TMDB_IMG}/w500{data['poster_path']}" if data.get("poster_path") else None,
        **tmdb_pick_images(data.get("images") or {}),
    })
    if series:
        try:
            season = await tmdb_get(f"/tv/{tmdb_id}/season/1", language="en-US")
            eps = [e for e in season.get("episodes") or [] if e.get("still_path")]
            d["stills"] = [pic(f"{TMDB_IMG}/original{e['still_path']}", f"{TMDB_IMG}/w500{e['still_path']}")
                           for e in spread(eps, MAX_STILLS)]
        except httpx.HTTPError as e:
            log.warning("TMDB season stills failed for %s: %s", tmdb_id, describe(e))
    return d


# --------------------------------------------------------------------------- routes


@app.get("/api/config")
async def config():
    return {"jellyfin": JF_ENABLED, "tmdb": TMDB_ENABLED}


@app.get("/api/search")
async def search(q: str = Query(min_length=1, max_length=200)):
    tasks, names = [], []
    if JF_ENABLED:
        tasks.append(jf_search(q)); names.append("Jellyfin")
    if TMDB_ENABLED:
        tasks.append(tmdb_search(q)); names.append("TMDB")
    if not tasks:
        raise HTTPException(503, "No data source configured (set JELLYFIN_URL/JELLYFIN_API_KEY and/or TMDB_API_KEY)")

    results, errors, seen = [], [], set()
    for name, res in zip(names, await asyncio.gather(*tasks, return_exceptions=True)):
        if isinstance(res, BaseException):
            log.warning("%s search failed: %s", name, describe(res))
            errors.append(f"{name} search failed: {describe(res)}")
            continue
        for r in res:
            # Hide TMDB hits that duplicate something already in the library.
            sig = ((r["title"] or "").casefold(), r["year"], r["kind"])
            if sig in seen:
                continue
            seen.add(sig)
            results.append(r)
    return {"results": results, "errors": errors}


@app.get("/api/title/{key:path}")
async def title(key: str):
    cached = cache_get(key)
    if cached:
        return cached
    try:
        if key.startswith("jf:") and JF_ENABLED and JF_ID_RE.match(key[3:]):
            d = await jf_details(key[3:])
        elif key.startswith("tmdb:") and TMDB_ENABLED:
            parts = key.split(":")
            if len(parts) != 3 or parts[1] not in ("movie", "tv") or not parts[2].isdigit():
                raise HTTPException(400, "Bad TMDB key")
            d = await tmdb_details(parts[1], parts[2])
        else:
            raise HTTPException(404, "Unknown or unavailable source")
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        raise HTTPException(404 if code == 404 else 502, f"Upstream error {code}") from e
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream error: {describe(e)}") from e
    cache_put(key, d)
    return d


@app.get("/img/jf/{item_id}/{kind}")
@app.get("/img/jf/{item_id}/{kind}/{index}")
async def jf_image(item_id: str, kind: str, index: int | None = None,
                   w: int = 1920, tag: str | None = None):
    if not JF_ENABLED or not JF_ID_RE.match(item_id) or kind not in JF_IMAGE_TYPES:
        raise HTTPException(404)
    path = f"/Items/{item_id}/Images/{kind}" + (f"/{index}" if index is not None else "")
    params = {"maxWidth": min(max(w, 64), 3840), "quality": 90}
    if tag:
        params["tag"] = tag
    try:
        r = await client.get(JF_URL + path, params=params, headers=JF_HEADERS)
    except httpx.HTTPError as e:
        raise HTTPException(502, describe(e)) from e
    if r.status_code != 200:
        raise HTTPException(404 if r.status_code == 404 else 502)
    return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
