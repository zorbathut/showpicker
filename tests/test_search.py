import httpx

from app.config import Config
from tests.conftest import CONFIG_JF
from tests.fakes import MOVIE_ID, TMDB_HOST, TMDB_KEY


def tmdb_hit(media, tmdb_id, title, date):
    date_field = "release_date" if media == "movie" else "first_air_date"
    return {"id": tmdb_id, "media_type": media, ("title" if media == "movie" else "name"): title, date_field: date, "poster_path": f"/p{tmdb_id}.jpg"}


def test_merges_library_first_and_hides_tmdb_duplicates(client, upstream):
    upstream.tmdb["/search/multi"] = {
        "results": [
            tmdb_hit("movie", 1, "Fake Movie", "2014-11-05"),  # same as the library movie
            tmdb_hit("movie", 2, "Fake Movie", "1990-01-01"),  # same name, different year: kept
            {"id": 3, "media_type": "person", "name": "Fake Person"},
            tmdb_hit("tv", 4, "Fake Movie: The Series", "2020-01-01"),
        ]
    }
    r = client.get("/api/search", params={"q": "fake movie"})
    assert r.status_code == 200
    assert [x["key"] for x in r.json()["results"]] == [f"jf:{MOVIE_ID}", "tmdb:movie:2", "tmdb:tv:4"]
    assert r.json()["errors"] == []
    lib = r.json()["results"][0]
    assert lib["source"] == "jellyfin" and lib["kind"] == "movie" and lib["year"] == 2014
    assert lib["poster"].startswith(f"/img/jf/{MOVIE_ID}/Primary?w=")


def test_one_source_failing_keeps_the_other_and_never_leaks_keys(client, upstream, expected_logs):
    def tmdb_down(request):
        # httpx puts the URL (which carries the v3 api_key) into connection errors' text in real life; make the fake do the same so redaction is tested.
        raise httpx.ConnectError(f"connection refused for {request.url}", request=request)

    upstream.broken[TMDB_HOST] = tmdb_down
    expected_logs.append("TMDB search failed")
    r = client.get("/api/search", params={"q": "fake"})
    assert r.status_code == 200
    assert {x["source"] for x in r.json()["results"]} == {"jellyfin"}
    [error] = r.json()["errors"]
    assert "TMDB search failed" in error
    assert TMDB_KEY not in error and "***" in error


def test_jellyfin_only_server_does_not_call_tmdb(connect, upstream):
    with connect(CONFIG_JF) as c:
        assert c.get("/api/search", params={"q": "fake"}).status_code == 200
    assert upstream.requests_to(TMDB_HOST) == []


def test_contract_break_is_logged_with_traceback(client, upstream, expected_logs, caplog):
    upstream.tmdb["/search/multi"] = {"unexpected": "shape"}
    expected_logs.append("TMDB search failed")
    r = client.get("/api/search", params={"q": "fake"})
    assert r.status_code == 200
    assert r.json()["errors"]
    [record] = [r for r in caplog.records if "TMDB search failed" in r.getMessage()]
    assert record.exc_info and record.exc_info[0] is KeyError


def test_tmdb_v4_token_goes_in_header_not_url(connect, upstream):
    token = "eyJhbGciOiJIUzI1NiJ9.fake.token"
    upstream.tmdb_bearer = token
    with connect(Config(jellyfin=None, tmdb_key=token)) as c:
        assert c.get("/api/search", params={"q": "x"}).status_code == 200
    [sent] = upstream.requests_to(TMDB_HOST)
    assert sent.headers["Authorization"] == f"Bearer {token}"
    assert token not in str(sent.url)


def test_query_required(client):
    assert client.get("/api/search", params={"q": ""}).status_code == 422
