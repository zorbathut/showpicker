"""A fake Jellyfin server and fake TMDB API behind one httpx.MockTransport handler.

Item shapes follow the real APIs, including that Jellyfin omits null properties entirely rather than sending null.
"""

import re
from urllib.parse import parse_qs

import httpx

JF_URL = "http://jf.test"
JF_KEY = "jf-secret-key"
TMDB_KEY = "tmdb-secret-key"
TMDB_HOST = "api.themoviedb.org"

MOVIE_ID = "a" * 32
SERIES_ID = "b" * 32
BARE_ID = "c" * 32  # a movie with almost no metadata


def jf_movie(item_id: str, name: str, **extra) -> dict:
    return {"Id": item_id, "Name": name, "Type": "Movie", "ImageTags": {}, "BackdropImageTags": [], **extra}


def jf_series(item_id: str, name: str, **extra) -> dict:
    return {"Id": item_id, "Name": name, "Type": "Series", "ImageTags": {}, "BackdropImageTags": [], **extra}


def jf_episode(index: int, season: int | None) -> dict:
    ep = {"Id": f"{index:032x}", "Name": f"Episode {index}", "Type": "Episode", "ImageTags": {"Primary": f"e{index}"}, "BackdropImageTags": []}
    if season is not None:
        ep["ParentIndexNumber"] = season
    return ep


def tmdb_image(path: str, lang: str | None, votes: float, count: int = 0) -> dict:
    return {"file_path": path, "iso_639_1": lang, "vote_average": votes, "vote_count": count, "width": 1920, "height": 1080}


class FakeUpstream:
    def __init__(self):
        self.jf_users = [{"Id": "user-plain", "Policy": {"IsAdministrator": False}}, {"Id": "user-admin", "Policy": {"IsAdministrator": True}}]
        self.jf_items: dict[str, dict] = {
            MOVIE_ID: jf_movie(
                MOVIE_ID,
                "Fake Movie",
                ProductionYear=2014,
                Overview="A movie.",
                Genres=["Sci-Fi"],
                CommunityRating=8.43,
                OfficialRating="PG-13",
                RunTimeTicks=169 * 600_000_000,
                Taglines=["Mankind was born on Earth."],
                ImageTags={"Primary": "p1", "Logo": "l1"},
                BackdropImageTags=["b1"],
                Chapters=[{"Name": f"Chapter {i}", "ImageTag": f"c{i}"} for i in range(11)],
                ProviderIds={"Tmdb": "157336"},
            ),
            SERIES_ID: jf_series(
                SERIES_ID, "Fake Series", ProductionYear=2008, EndDate="2013-09-29T00:00:00.0000000Z", Status="Ended", ChildCount=5, BackdropImageTags=["b3"]
            ),
            BARE_ID: jf_movie(BARE_ID, "Bare Movie"),
        }
        # Two specials, then a season-1 episode missing ParentIndexNumber (Jellyfin omits it when unknown), then 20 regular episodes.
        self.jf_episodes: dict[str, list[dict]] = {
            SERIES_ID: [jf_episode(0, 0), jf_episode(1, 0), jf_episode(2, None), *[jf_episode(i, 1 + (i - 3) // 10) for i in range(3, 23)]]
        }
        self.tmdb: dict[str, dict] = {
            "/search/multi": {"results": []},
            "/movie/157336/images": {"logos": [], "backdrops": [tmdb_image(f"/tb{i}.jpg", None, 5 - i * 0.1) for i in range(3)]},
        }
        # Per-host override: called instead of the fake; return a Response or raise.
        self.broken: dict[str, object] = {}
        self.requests: list[httpx.Request] = []
        self.tmdb_bearer: str | None = None  # set when the app is configured with a v4 token instead of TMDB_KEY

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        override = self.broken.get(request.url.host)
        if override:
            return override(request)
        if request.url.host == "jf.test":
            return self.jellyfin(request)
        if request.url.host == TMDB_HOST:
            return self.tmdb_api(request)
        raise AssertionError(f"unexpected request to {request.url}")

    def requests_to(self, host: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == host]

    def jellyfin(self, request: httpx.Request) -> httpx.Response:
        assert f'Token="{JF_KEY}"' in request.headers["Authorization"]
        q = {k.lower(): v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        path = request.url.path
        if path == "/Users":
            return httpx.Response(200, json=self.jf_users)
        if path == "/Items":
            assert q["userid"] == "user-admin"
            if "ids" in q:
                return httpx.Response(200, json={"Items": [self.jf_items[q["ids"]]] if q["ids"] in self.jf_items else [], "TotalRecordCount": 0})
            if "parentid" in q:
                return httpx.Response(200, json={"Items": self.jf_episodes.get(q["parentid"], [])})
            term = q.get("searchterm", "").casefold()
            return httpx.Response(200, json={"Items": [it for it in self.jf_items.values() if term in it["Name"].casefold()]})
        if re.fullmatch(r"/Items/\w+/Images/\w+(/\d+)?", path):
            return httpx.Response(200, content=b"\xff\xd8fake-jpeg", headers={"content-type": "image/jpeg"})
        return httpx.Response(404)

    def tmdb_api(self, request: httpx.Request) -> httpx.Response:
        if self.tmdb_bearer:
            assert request.headers["Authorization"] == f"Bearer {self.tmdb_bearer}" and "api_key" not in request.url.params
        else:
            assert request.url.params.get("api_key") == TMDB_KEY
        path = request.url.path.removeprefix("/3")
        if path in self.tmdb:
            return httpx.Response(200, json=self.tmdb[path])
        return httpx.Response(404, json={"status_message": "The resource you requested could not be found."})
