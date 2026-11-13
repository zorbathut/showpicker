import httpx
import pytest

from app.main import CACHE_DEGRADED_TTL_S, CACHE_TTL_S
from tests.conftest import CONFIG_JF, CONFIG_TMDB
from tests.fakes import JF_KEY, MOVIE_ID, SERIES_ID, TMDB_HOST
from tests.test_title import INVALID_KEYS, VALID_KEYS


@pytest.mark.parametrize("key", INVALID_KEYS[1:])  # "" routes elsewhere
def test_title_malformed_key_is_400(client, key):
    r = client.get(f"/api/title/{key}")
    assert r.status_code == 400
    assert "Not a valid title key" in r.json()["detail"]


@pytest.mark.parametrize("key", VALID_KEYS)
def test_title_valid_keys_get_past_parsing(client, key):
    assert client.get(f"/api/title/{key}").status_code in (200, 404)


def test_title_source_not_configured_is_404(connect):
    with connect(CONFIG_TMDB) as c:
        r = c.get(f"/api/title/jf:{MOVIE_ID}")
    assert r.status_code == 404 and "Jellyfin is not configured" in r.json()["detail"]
    with connect(CONFIG_JF) as c:
        r = c.get("/api/title/tmdb:movie:1")
    assert r.status_code == 404 and "TMDB is not configured" in r.json()["detail"]


def test_title_upstream_failure_is_502(client, upstream):
    upstream.broken["jf.test"] = lambda request: httpx.Response(500)
    r = client.get(f"/api/title/jf:{MOVIE_ID}")
    assert r.status_code == 502


def test_title_upstream_404_is_404(client, upstream):
    r = client.get("/api/title/tmdb:movie:999")  # the fake TMDB has no such movie
    assert r.status_code == 404 and "No such title" in r.json()["detail"]
    r = client.get("/api/title/jf:" + "f" * 32)  # Jellyfin answers an unknown id with an empty list
    assert r.status_code == 404


def test_title_cached_until_ttl(client, upstream, clock):
    first = client.get(f"/api/title/jf:{MOVIE_ID}").json()
    count = len(upstream.requests)
    clock.now += CACHE_TTL_S - 1
    assert client.get(f"/api/title/jf:{MOVIE_ID}").json() == first
    assert len(upstream.requests) == count
    clock.now += 2
    client.get(f"/api/title/jf:{MOVIE_ID}")
    assert len(upstream.requests) > count


def test_degraded_title_cached_briefly(client, upstream, clock, expected_logs):
    upstream.broken[TMDB_HOST] = lambda request: httpx.Response(500)
    expected_logs.append("using library artwork only")
    client.get(f"/api/title/jf:{MOVIE_ID}")
    del upstream.broken[TMDB_HOST]
    clock.now += CACHE_DEGRADED_TTL_S + 1
    healed = client.get(f"/api/title/jf:{MOVIE_ID}").json()
    assert any("tmdb.org" in p["full"] for p in healed["gallery"])


def test_cache_cleared_when_full(client, upstream, monkeypatch):
    monkeypatch.setattr("app.main.CACHE_MAX_ENTRIES", 1)
    client.get(f"/api/title/jf:{MOVIE_ID}")
    client.get(f"/api/title/jf:{SERIES_ID}")  # evicts the movie
    count = len(upstream.requests)
    client.get(f"/api/title/jf:{MOVIE_ID}")
    assert len(upstream.requests) > count


def test_image_proxy(client, upstream):
    r = client.get(f"/img/jf/{MOVIE_ID}/Backdrop/0", params={"w": 99999, "tag": "b1"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert "max-age" in r.headers["cache-control"]
    sent = upstream.requests[-1]
    assert sent.url.path == f"/Items/{MOVIE_ID}/Images/Backdrop/0"
    assert sent.url.params["maxWidth"] == "3840" and sent.url.params["tag"] == "b1"
    assert JF_KEY not in str(sent.url)  # the key travels in the header only


def test_image_proxy_without_index(client, upstream):
    assert client.get(f"/img/jf/{MOVIE_ID}/Logo", params={"w": 10}).status_code == 200
    assert upstream.requests[-1].url.params["maxWidth"] == "64"


@pytest.mark.parametrize("path", [f"/img/jf/{MOVIE_ID}/Evil", "/img/jf/notanid/Backdrop", f"/img/jf/{MOVIE_ID}/Backdrop/x"])
def test_image_proxy_refuses_bad_requests(client, upstream, path):
    assert client.get(path, params={"w": 640}).status_code in (404, 422)
    assert upstream.requests == []


def test_image_proxy_requires_width(client):
    assert client.get(f"/img/jf/{MOVIE_ID}/Logo").status_code == 422


def test_config_endpoint(connect):
    with connect(CONFIG_TMDB) as c:
        assert c.get("/api/config").json() == {"jellyfin": False, "tmdb": True, "lineup_max": 50}


def test_index_served(client, upstream):
    assert "<title>Showpicker</title>" in client.get("/").text
    assert upstream.requests_to(TMDB_HOST) == []
