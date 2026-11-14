"""Against the real Jellyfin and TMDB from config.env: checks our beliefs about the response shapes that the fakes encode. Opt-in: `pytest -m live`."""

import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import config_from_env
from app.main import app_create

pytestmark = pytest.mark.live

CONFIG_ENV = Path(__file__).parent.parent / "config.env"


def read_env_file(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            name, _, value = line.partition("=")
            env[name.strip()] = value.strip()
    return env


@pytest.fixture(scope="module")
def live():
    if not CONFIG_ENV.exists():
        pytest.fail(f"live tests need {CONFIG_ENV}")
    config = config_from_env(read_env_file(CONFIG_ENV))
    if not (config.jellyfin and config.tmdb_key):
        pytest.fail("live tests need both Jellyfin and TMDB configured")
    with TestClient(app_create(config, None, time.time)) as c:
        yield c


def first_hit(client, q, source, kind):
    r = client.get("/api/search", params={"q": q})
    assert r.status_code == 200 and r.json()["errors"] == []
    hits = [x for x in r.json()["results"] if x["source"] == source and x["kind"] == kind]
    assert hits, f"no {source} {kind} found for {q!r}; adjust the query to something in the library"
    return hits[0]


def assert_title_ok(client, key):
    d = client.get(f"/api/title/{key}").json()
    assert d["title"], d
    assert d["gallery"], f"{key} has no images"
    for p in d["gallery"][:3]:
        url = p["full"] if p["full"].startswith("http") else None
        if url:
            assert httpx.head(url, follow_redirects=True).status_code == 200, url
        else:
            assert client.get(p["full"]).status_code == 200, p["full"]
    return d


def test_library_movie(live):
    d = assert_title_ok(live, first_hit(live, "bad guys", "jellyfin", "movie")["key"])
    assert d["logo"]
    assert "/Thumb?" in d["gallery"][0]["full"], "this title has Jellyfin title art (Thumb), which should lead"


def test_library_series(live):
    assert_title_ok(live, first_hit(live, "star vs", "jellyfin", "series")["key"])


def test_tmdb_only_series_stills_at_full_width(live):
    d = assert_title_ok(live, first_hit(live, "severance", "tmdb", "series")["key"])
    stills = [p for p in d["gallery"] if "/w1280/" in p["full"]]
    assert stills
    for p in stills:
        assert httpx.head(p["full"], follow_redirects=True).status_code == 200, p["full"]
        assert httpx.head(p["thumb"], follow_redirects=True).status_code == 200, p["thumb"]
