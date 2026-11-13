import pytest

from app.main import LINEUP_MAX
from tests.conftest import CONFIG_BOTH
from tests.fakes import MOVIE_ID, SERIES_ID
from tests.test_title import INVALID_KEYS, VALID_KEYS


def put(client, base, keys):
    return client.put("/api/lineup", json={"base_instance": base["instance"], "base_version": base["version"], "keys": keys})


def current(client):
    return client.get("/api/lineup").json()


def test_starts_empty(client):
    state = current(client)
    assert state["keys"] == [] and state["version"] == 0 and state["instance"]


def test_put_replaces_and_bumps_version(client):
    s0 = current(client)
    r = put(client, s0, [f"jf:{MOVIE_ID}", "tmdb:tv:1"])
    assert r.status_code == 200
    assert r.json() == {**s0, "version": 1, "keys": [f"jf:{MOVIE_ID}", "tmdb:tv:1"]}
    assert current(client) == r.json()
    assert put(client, r.json(), []).json() == {**s0, "version": 2, "keys": []}


def test_stale_base_version_is_409_with_current_state(client):
    s0 = current(client)
    put(client, s0, [f"jf:{MOVIE_ID}"])
    r = put(client, s0, [f"jf:{SERIES_ID}"])
    assert r.status_code == 409
    assert r.json() == {**s0, "version": 1, "keys": [f"jf:{MOVIE_ID}"]}


def test_other_instance_is_409(client):
    s0 = current(client)
    r = put(client, {**s0, "instance": "an-earlier-server"}, ["tmdb:movie:1"])
    assert r.status_code == 409 and r.json() == s0


@pytest.mark.parametrize("key", VALID_KEYS)
def test_accepts_every_valid_key(client, key):
    assert put(client, current(client), [key]).status_code == 200


@pytest.mark.parametrize("key", INVALID_KEYS)
def test_refuses_invalid_key_and_changes_nothing(client, key):
    s0 = current(client)
    r = put(client, s0, ["tmdb:movie:1", key])
    assert r.status_code == 400 and "Not a valid title key" in r.json()["detail"]
    assert current(client) == s0


def test_refuses_duplicates(client):
    r = put(client, current(client), ["tmdb:movie:1", "tmdb:movie:1"])
    assert r.status_code == 400 and "twice" in r.json()["detail"]


def test_refuses_too_many(client):
    s1 = put(client, current(client), [f"tmdb:movie:{i}" for i in range(LINEUP_MAX)]).json()
    r = put(client, s1, [f"tmdb:movie:{i}" for i in range(LINEUP_MAX + 1)])
    assert r.status_code == 400 and "full" in r.json()["detail"]
    assert current(client) == s1


@pytest.mark.parametrize(
    "body",
    [
        {"base_instance": "x", "keys": []},
        {"base_version": 0, "keys": []},
        {"base_instance": "x", "base_version": 0},
        {"base_instance": "x", "base_version": 0, "keys": [], "extra": 1},
        {"base_instance": "x", "base_version": 0, "keys": "tmdb:movie:1"},
    ],
)
def test_refuses_bad_body_shape(client, body):
    assert client.put("/api/lineup", json=body).status_code == 422


def test_app_instances_do_not_share_lineups(connect):
    with connect(CONFIG_BOTH) as a, connect(CONFIG_BOTH) as b:
        put(a, current(a), ["tmdb:movie:1"])
        assert current(b)["keys"] == []
        assert current(a)["instance"] != current(b)["instance"]
