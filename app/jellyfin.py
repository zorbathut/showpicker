"""Jellyfin: search the user's library and describe items, with image URLs pointing at our own proxy."""

import logging

import httpx

from app.config import JellyfinConfig
from app.redact import describe
from app.title import IMAGE_FULL_W, IMAGE_THUMB_W, MAX_STILLS, SearchHit, TitleDraft, TitleInfo, TitleKeyJellyfin, pic, spread, year_of

log = logging.getLogger(__name__)

JF_IMAGE_TYPES = {"Primary", "Backdrop", "Logo", "Thumb", "Chapter"}
SEARCH_LIMIT = 8
POSTER_SEARCH_W = 120
POSTER_W = 600
LOGO_W = 1000
EARLY_EPISODES = 12  # stills come from this many earliest regular episodes, to keep spoilers down
MOVIE_STILLS_FRACTION = 0.6  # chapter stills come from this leading fraction of the film, staying out of the ending
TICKS_PER_MINUTE = 600_000_000


def proxy_url(item_id: str, kind: str, index: int | None, tag: str | None, width: int) -> str:
    path = f"/img/jf/{item_id}/{kind}" + (f"/{index}" if index is not None else "")
    return path + f"?w={width}" + (f"&tag={tag}" if tag else "")


def proxy_pic(item_id: str, kind: str, index: int | None, tag: str) -> dict:
    return pic(proxy_url(item_id, kind, index, tag, IMAGE_FULL_W), proxy_url(item_id, kind, index, tag, IMAGE_THUMB_W))


class Jellyfin:
    """A class because it carries the lazily resolved user id: API keys aren't tied to a user, but item queries want one."""

    def __init__(self, config: JellyfinConfig, client: httpx.AsyncClient):
        self.config = config
        self.client = client
        self.user_id = config.user_id
        self.headers = {
            "Authorization": f'MediaBrowser Client="Showpicker", Device="Showpicker", DeviceId="showpicker", Version="1.0", Token="{config.key}"',
            "Accept": "application/json",
        }

    async def get(self, path: str, params: dict):
        r = await self.client.get(self.config.url + path, params=params, headers=self.headers)
        r.raise_for_status()
        return r.json()

    async def user(self) -> str:
        if not self.user_id:
            users = await self.get("/Users", {})
            if not users:
                raise RuntimeError("Jellyfin returned no users")
            admins = [u for u in users if (u.get("Policy") or {}).get("IsAdministrator")]
            self.user_id = (admins or users)[0]["Id"]
        return self.user_id

    async def search(self, q: str) -> list[SearchHit]:
        uid = await self.user()
        params = {"userId": uid, "searchTerm": q, "IncludeItemTypes": "Movie,Series", "Recursive": "true", "Limit": SEARCH_LIMIT, "Fields": "ProductionYear"}
        data = await self.get("/Items", params)
        out = []
        for it in data["Items"]:
            tag = it["ImageTags"].get("Primary")
            out.append(
                SearchHit(
                    key=TitleKeyJellyfin(it["Id"]),
                    source="jellyfin",
                    kind="series" if it["Type"] == "Series" else "movie",
                    title=it.get("Name"),
                    year=it.get("ProductionYear"),
                    poster=proxy_url(it["Id"], "Primary", None, tag, POSTER_SEARCH_W) if tag else None,
                )
            )
        return out

    async def episode_stills(self, uid: str, series_id: str) -> list[dict]:
        params = {
            "userId": uid,
            "ParentId": series_id,
            "IncludeItemTypes": "Episode",
            "Recursive": "true",
            "SortBy": "ParentIndexNumber,IndexNumber",
            "Limit": 60,
            "ImageTypes": "Primary",
            "Fields": "ParentIndexNumber",
        }
        data = await self.get("/Items", params)
        # Season 0 is specials, which are often behind-the-scenes material rather than the show itself.
        eps = [e for e in data["Items"] if e.get("ParentIndexNumber") not in (None, 0) and e["ImageTags"].get("Primary")]
        return [proxy_pic(e["Id"], "Primary", None, e["ImageTags"]["Primary"]) for e in spread(eps[:EARLY_EPISODES], MAX_STILLS)]

    async def details(self, item_id: str) -> TitleDraft | None:
        """None when the item doesn't exist."""
        uid = await self.user()
        fields = "Overview,Genres,ProductionYear,Chapters,OfficialRating,CommunityRating,RunTimeTicks,Taglines,ChildCount,ProviderIds,Status,EndDate"
        data = await self.get("/Items", {"userId": uid, "ids": item_id, "Fields": fields})
        if not data["Items"]:
            return None
        it = data["Items"][0]
        iid = it["Id"]
        tags = it["ImageTags"]
        series = it["Type"] == "Series"

        degraded = False
        if series:
            try:
                stills = await self.episode_stills(uid, iid)
            except httpx.HTTPError as e:
                log.warning("Jellyfin episode stills failed for %s: %s", iid, describe(e, [self.config.key]))
                stills = []
                degraded = True
        else:
            chapters = [(i, c) for i, c in enumerate(it.get("Chapters") or []) if c.get("ImageTag")]
            if len(chapters) > 2:
                chapters = chapters[1:]  # chapter 0 is usually studio logos or black
            chapters = chapters[: max(1, int(len(chapters) * MOVIE_STILLS_FRACTION))]
            stills = [proxy_pic(iid, "Chapter", i, c["ImageTag"]) for i, c in spread(chapters, MAX_STILLS)]

        return TitleDraft(
            key=TitleKeyJellyfin(iid),
            source="jellyfin",
            kind="series" if series else "movie",
            info=TitleInfo(
                title=it.get("Name"),
                year=it.get("ProductionYear"),
                end_year=year_of(it.get("EndDate")),
                status=it.get("Status"),
                tagline=(it.get("Taglines") or [None])[0],
                overview=it.get("Overview"),
                genres=it.get("Genres") or [],
                rating=round(it["CommunityRating"], 1) if it.get("CommunityRating") else None,
                certification=it.get("OfficialRating"),
                runtime=round(it["RunTimeTicks"] / TICKS_PER_MINUTE) if it.get("RunTimeTicks") else None,
                seasons=it.get("ChildCount") if series else None,
                logo=proxy_url(iid, "Logo", None, tags["Logo"], LOGO_W) if "Logo" in tags else None,
                poster=proxy_url(iid, "Primary", None, tags["Primary"], POSTER_W) if "Primary" in tags else None,
            ),
            backdrops=[proxy_pic(iid, "Backdrop", i, t) for i, t in enumerate(it["BackdropImageTags"])],
            stills=stills,
            tmdb_id=(it.get("ProviderIds") or {}).get("Tmdb"),
            degraded=degraded,
        )

    async def image(self, item_id: str, kind: str, index: int | None, width: int, tag: str | None) -> httpx.Response:
        path = f"/Items/{item_id}/Images/{kind}" + (f"/{index}" if index is not None else "")
        params = {"maxWidth": width, "quality": 90}
        if tag:
            params["tag"] = tag
        return await self.client.get(self.config.url + path, params=params, headers=self.headers)
