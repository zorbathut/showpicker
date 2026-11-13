"""TMDB: titles outside the library, and extra artwork for library titles."""

import logging

import httpx

from app.redact import describe
from app.title import IMAGE_FULL_W, MAX_STILLS, SearchHit, TitleDraft, TitleInfo, TitleKeyTmdb, pic, spread, year_of

log = logging.getLogger(__name__)

TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p"
SEARCH_LIMIT = 8
# TMDB serves only fixed widths; these are the nearest to IMAGE_FULL_W / IMAGE_THUMB_W.
FULL = f"w{IMAGE_FULL_W}"
THUMB = "w780"
LOGO = "w500"
POSTER = "w500"
POSTER_SEARCH = "w154"


def tmdb_img(size: str, path: str) -> str:
    return f"{TMDB_IMG}/{size}{path}"


def tmdb_pic(path: str) -> dict:
    return pic(tmdb_img(FULL, path), tmdb_img(THUMB, path))


def pick_images(images: dict) -> tuple[str | None, list[dict]]:
    """The best logo (English first, then by votes) and backdrops ranked textless-first, since a baked-in title clashes with our own logo."""
    logos = sorted(images["logos"], key=lambda logo: (logo.get("iso_639_1") != "en", -(logo.get("vote_average") or 0)))
    backdrops = sorted(images["backdrops"], key=lambda b: (b.get("iso_639_1") is not None, -(b.get("vote_average") or 0)))
    logo = tmdb_img(LOGO, logos[0]["file_path"]) if logos else None
    return logo, [tmdb_pic(b["file_path"]) for b in backdrops]


class Tmdb:
    def __init__(self, key: str, client: httpx.AsyncClient):
        self.key = key
        self.client = client

    async def get(self, path: str, params: dict):
        headers = {"Accept": "application/json"}
        if self.key.startswith("eyJ"):  # a v4 read-access token (a JWT); otherwise it's a v3 API key
            headers["Authorization"] = f"Bearer {self.key}"
        else:
            params = {**params, "api_key": self.key}
        r = await self.client.get(TMDB_API + path, params=params, headers=headers)
        r.raise_for_status()
        return r.json()

    async def search(self, q: str) -> list[SearchHit]:
        data = await self.get("/search/multi", {"query": q, "include_adult": "false", "language": "en-US"})
        out = []
        for r in data["results"]:
            media = r["media_type"]
            if media not in ("movie", "tv"):
                continue
            out.append(
                SearchHit(
                    key=TitleKeyTmdb(media, r["id"]),
                    source="tmdb",
                    kind="series" if media == "tv" else "movie",
                    title=r.get("title") or r.get("name"),
                    year=year_of(r.get("release_date") or r.get("first_air_date")),
                    poster=tmdb_img(POSTER_SEARCH, r["poster_path"]) if r.get("poster_path") else None,
                )
            )
            if len(out) >= SEARCH_LIMIT:
                break
        return out

    async def images(self, media: str, tmdb_id: str | int) -> tuple[str | None, list[dict]]:
        return pick_images(await self.get(f"/{media}/{tmdb_id}/images", {"include_image_language": "en,null"}))

    async def details(self, media: str, tmdb_id: int) -> TitleDraft | None:
        """None when TMDB has no such title."""
        try:
            data = await self.get(f"/{media}/{tmdb_id}", {"append_to_response": "images", "include_image_language": "en,null", "language": "en-US"})
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return None
            raise
        series = media == "tv"
        logo, backdrops = pick_images(data["images"])
        stills = []
        degraded = False
        if series:
            try:
                season = await self.get(f"/tv/{tmdb_id}/season/1", {"language": "en-US"})
                eps = [e for e in season.get("episodes") or [] if e.get("still_path")]
                stills = [tmdb_pic(e["still_path"]) for e in spread(eps, MAX_STILLS)]
            except httpx.HTTPError as e:
                log.warning("TMDB season stills failed for %s: %s", tmdb_id, describe(e, [self.key]))
                degraded = True
        runtime = (data.get("episode_run_time") or [None])[0] if series else data.get("runtime")
        return TitleDraft(
            key=TitleKeyTmdb(media, tmdb_id),
            source="tmdb",
            kind="series" if series else "movie",
            info=TitleInfo(
                title=data.get("title") or data.get("name"),
                year=year_of(data.get("release_date") or data.get("first_air_date")),
                end_year=year_of(data.get("last_air_date")) if series and data.get("status") == "Ended" else None,
                status=data.get("status"),
                tagline=data.get("tagline") or None,
                overview=data.get("overview"),
                genres=[g["name"] for g in data.get("genres") or []],
                rating=round(data["vote_average"], 1) if data.get("vote_average") else None,
                runtime=runtime,
                seasons=data.get("number_of_seasons") if series else None,
                logo=logo,
                poster=tmdb_img(POSTER, data["poster_path"]) if data.get("poster_path") else None,
            ),
            backdrops=backdrops,
            stills=stills,
            tmdb_id=None,
            degraded=degraded,
        )
