import re

import httpx

from tests.conftest import CONFIG_JF, CONFIG_TMDB
from tests.fakes import BARE_ID, JF_KEY, MOVIE_ID, SERIES_ID, TMDB_HOST, tmdb_image


def image_ids(gallery, kind):
    """The image indices (chapters) or episode ids (episode stills) of the gallery entries of one Jellyfin image kind."""
    out = []
    for p in gallery:
        m = re.match(rf"/img/jf/(\w+)/{kind}(?:/(\d+))?\?", p["full"])
        if m:
            out.append(m.group(2) if m.group(2) is not None else m.group(1))
    return out


def test_movie_details(client):
    d = client.get(f"/api/title/jf:{MOVIE_ID}").json()
    assert d["key"] == f"jf:{MOVIE_ID}" and d["source"] == "jellyfin" and d["kind"] == "movie"
    assert (d["title"], d["year"], d["runtime"], d["rating"], d["certification"], d["tagline"]) == (
        "Fake Movie",
        2014,
        169,
        8.4,
        "PG-13",
        "Mankind was born on Earth.",
    )
    assert d["logo"].startswith(f"/img/jf/{MOVIE_ID}/Logo?w=")
    assert "backdrops" not in d and "stills" not in d


def test_movie_stills_skip_first_chapter_and_ending(client):
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    # 11 chapters: drop chapter 0 (studio logos), keep the first 60% of the remaining 10 → chapters 1-6.
    assert image_ids(gallery, "Chapter") == ["1", "2", "3", "4", "5", "6"]


def test_tmdb_backdrops_replace_library_backdrops_when_at_least_as_many(client):
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    backdrops = [p["full"] for p in gallery if "/Chapter/" not in p["full"]]
    assert backdrops == [f"https://image.tmdb.org/t/p/w1280/tb{i}.jpg" for i in range(3)]
    assert gallery[0]["full"].endswith("/tb0.jpg") and "/Chapter/" in gallery[1]["full"]


def test_library_backdrops_kept_when_tmdb_has_fewer(client, upstream):
    upstream.jf_items[MOVIE_ID]["BackdropImageTags"] = ["x0", "x1", "x2", "x3"]
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    assert image_ids(gallery, "Backdrop") == ["0", "1", "2", "3"]
    assert not any("tmdb.org" in p["full"] for p in gallery)


def test_tmdb_fills_missing_logo(client, upstream):
    upstream.jf_items[MOVIE_ID]["ImageTags"] = {"Primary": "p1"}
    upstream.tmdb["/movie/157336/images"]["logos"] = [tmdb_image("/logo-de.png", "de", 9), tmdb_image("/logo-en.png", "en", 1)]
    assert client.get(f"/api/title/jf:{MOVIE_ID}").json()["logo"] == "https://image.tmdb.org/t/p/w500/logo-en.png"


def test_tmdb_artwork_failure_falls_back_to_library(client, upstream, expected_logs):
    upstream.broken[TMDB_HOST] = lambda request: httpx.Response(500)
    expected_logs.append("using library artwork only")
    d = client.get(f"/api/title/jf:{MOVIE_ID}").json()
    assert image_ids(d["gallery"], "Backdrop") == ["0"]


def test_no_tmdb_call_without_provider_id_or_without_tmdb(client, connect, upstream):
    client.get(f"/api/title/jf:{SERIES_ID}")
    assert upstream.requests_to(TMDB_HOST) == []
    with connect(CONFIG_JF) as c:
        c.get(f"/api/title/jf:{MOVIE_ID}")
    assert upstream.requests_to(TMDB_HOST) == []


def test_series_stills_skip_specials_and_come_from_early_episodes(client):
    d = client.get(f"/api/title/jf:{SERIES_ID}").json()
    assert (d["kind"], d["year"], d["end_year"], d["seasons"]) == ("series", 2008, 2013, 5)
    # Episodes 0-1 are specials and 2 has no season number; the next 12 (3-14) are spread down to 6.
    assert image_ids(d["gallery"], "Primary") == [f"{i:032x}" for i in (3, 5, 7, 10, 12, 14)]
    # The single library backdrop leads, then stills.
    assert "/Backdrop/0?" in d["gallery"][0]["full"]


def test_item_with_omitted_optional_fields(client):
    d = client.get(f"/api/title/jf:{BARE_ID}").json()
    assert d["title"] == "Bare Movie"
    assert (d["year"], d["logo"], d["poster"], d["tagline"], d["genres"], d["gallery"]) == (None, None, None, None, [], [])


def test_admin_user_used_and_resolved_once(client, upstream):
    client.get(f"/api/title/jf:{MOVIE_ID}")
    client.get(f"/api/title/jf:{SERIES_ID}")
    assert len([r for r in upstream.requests if r.url.path == "/Users"]) == 1


def test_tmdb_movie_details(connect, upstream):
    upstream.tmdb["/movie/329865"] = {
        "id": 329865,
        "title": "Arrival",
        "release_date": "2016-11-10",
        "runtime": 116,
        "vote_average": 7.6,
        "genres": [{"id": 1, "name": "Drama"}],
        "tagline": "",
        "images": {
            "logos": [tmdb_image("/l.png", "en", 3)],
            "backdrops": [tmdb_image("/with-text.jpg", "en", 9), tmdb_image("/textless-low.jpg", None, 2), tmdb_image("/textless-high.jpg", None, 6)],
        },
    }
    with connect(CONFIG_TMDB) as c:
        d = c.get("/api/title/tmdb:movie:329865").json()
    assert (d["title"], d["year"], d["runtime"], d["tagline"], d["genres"]) == ("Arrival", 2016, 116, None, ["Drama"])
    assert [p["full"].rsplit("/", 1)[1] for p in d["gallery"]] == ["textless-high.jpg", "textless-low.jpg", "with-text.jpg"]
    assert all(p["full"].startswith("https://image.tmdb.org/t/p/w1280/") for p in d["gallery"])


def test_tmdb_series_details_with_season_one_stills(connect, upstream):
    upstream.tmdb["/tv/95396"] = {
        "id": 95396,
        "name": "Severance",
        "first_air_date": "2022-02-17",
        "last_air_date": "2025-03-20",
        "status": "Returning Series",
        "number_of_seasons": 2,
        "episode_run_time": [],
        "images": {"logos": [], "backdrops": [tmdb_image("/bd.jpg", None, 5)]},
    }
    upstream.tmdb["/tv/95396/season/1"] = {"episodes": [{"still_path": f"/s{i}.jpg"} for i in range(9)] + [{"still_path": None}]}
    with connect(CONFIG_TMDB) as c:
        d = c.get("/api/title/tmdb:tv:95396").json()
    assert (d["kind"], d["end_year"], d["seasons"], d["runtime"]) == ("series", None, 2, None)
    assert [p["full"].rsplit("/", 1)[1] for p in d["gallery"]] == ["bd.jpg", "s0.jpg", "s2.jpg", "s3.jpg", "s5.jpg", "s6.jpg", "s8.jpg"]


def test_image_urls_never_carry_keys(client):
    body = client.get(f"/api/title/jf:{MOVIE_ID}").text
    assert JF_KEY not in body
