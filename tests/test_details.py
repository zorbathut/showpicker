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
    assert (d["title"], d["year"], d["runtime"], d["certification"], d["tagline"]) == (
        "Fake Movie",
        2014,
        169,
        "PG-13",
        "Mankind was born on Earth.",
    )
    assert d["logo"].startswith(f"/img/jf/{MOVIE_ID}/Logo?w=")
    assert "rating" not in d  # the fake library sends CommunityRating; it's deliberately not shown
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
    assert not any("tmdb.org" in p["full"] for p in d["gallery"])


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
    # The English backdrop is the title art and leads; the rest are ranked textless-first.
    assert [p["full"].rsplit("/", 1)[1] for p in d["gallery"]] == ["with-text.jpg", "textless-high.jpg", "textless-low.jpg"]
    assert all(p["full"].startswith("https://image.tmdb.org/t/p/w1280/") for p in d["gallery"])


def test_tmdb_title_art_choice(connect, upstream):
    upstream.tmdb["/movie/329865"] = {
        "id": 329865,
        "title": "Arrival",
        "images": {
            "logos": [],
            "backdrops": [
                tmdb_image("/en-a.jpg", "en", 5, count=10),
                tmdb_image("/en-b.jpg", "en", 5, count=50),  # ties en-a on votes, wins on vote count
                tmdb_image("/en-c.jpg", "en", 3),
                tmdb_image("/textless.jpg", None, 9),
            ],
        },
    }
    with connect(CONFIG_TMDB) as c:
        d = c.get("/api/title/tmdb:movie:329865").json()
    assert [p["full"].rsplit("/", 1)[1] for p in d["gallery"]] == ["en-b.jpg", "textless.jpg", "en-a.jpg", "en-c.jpg"]


def test_library_thumb_leads(client, upstream):
    upstream.jf_items[MOVIE_ID]["ImageTags"]["Thumb"] = "t1"
    d = client.get(f"/api/title/jf:{MOVIE_ID}").json()
    assert d["gallery"][0]["full"].startswith(f"/img/jf/{MOVIE_ID}/Thumb?w=") and "tag=t1" in d["gallery"][0]["full"]


def test_library_thumb_leads_and_tmdb_titled_backdrops_are_dropped(client, upstream):
    # Jellyfin's Thumb is usually a copy of one of TMDB's titled backdrops (not necessarily the best-voted), so none of them are shown.
    upstream.jf_items[MOVIE_ID]["ImageTags"]["Thumb"] = "t1"
    upstream.tmdb["/movie/157336/images"]["backdrops"] += [tmdb_image("/tmdb-title.jpg", "en", 5), tmdb_image("/tmdb-title-2.jpg", "en", 1)]
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    assert "/Thumb?" in gallery[0]["full"]
    backdrops = [p["full"].rsplit("/", 1)[1] for p in gallery if "tmdb.org" in p["full"]]
    assert backdrops == ["tb0.jpg", "tb1.jpg", "tb2.jpg"]


def test_tmdb_backdrop_count_includes_titled_backdrops(client, upstream):
    # Library: 3 backdrops. TMDB: 2 textless + 1 titled = 3, which is "at least as many", so TMDB's set is used and its titled one leads.
    upstream.jf_items[MOVIE_ID]["BackdropImageTags"] = ["x0", "x1", "x2"]
    upstream.tmdb["/movie/157336/images"]["backdrops"] = [
        tmdb_image("/tb0.jpg", None, 5),
        tmdb_image("/tb1.jpg", None, 4),
        tmdb_image("/tmdb-title.jpg", "en", 1),
    ]
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    assert gallery[0]["full"].endswith("/tmdb-title.jpg")
    assert image_ids(gallery, "Backdrop") == []


def test_library_without_thumb_takes_tmdb_title_art(client, upstream):
    upstream.tmdb["/movie/157336/images"]["backdrops"].append(tmdb_image("/tmdb-title.jpg", "en", 1))
    gallery = client.get(f"/api/title/jf:{MOVIE_ID}").json()["gallery"]
    assert gallery[0]["full"] == "https://image.tmdb.org/t/p/w1280/tmdb-title.jpg"
    assert sum("tmdb-title.jpg" in p["full"] for p in gallery) == 1


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
