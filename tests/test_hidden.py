import pytest

from app.main import HIDDEN_IMAGE_MAX_LEN
from tests.fakes import MOVIE_ID, SERIES_ID

MOVIE = f"jf:{MOVIE_ID}"
SERIES = f"jf:{SERIES_ID}"


def hide(client, key, image, hidden=True):
    return client.post("/api/hidden", json={"key": key, "image": image, "hidden": hidden})


def state(client):
    return client.get("/api/lineup").json()


def test_starts_empty(client):
    s = state(client)
    assert (s["hidden"], s["hidden_version"]) == ({}, 0)


def test_hide_and_unhide(client):
    r = hide(client, MOVIE, "/img/a")
    assert r.status_code == 200
    assert r.json() == {"instance": state(client)["instance"], "hidden_version": 1, "hidden": {MOVIE: ["/img/a"]}}
    hide(client, MOVIE, "/img/b")
    assert state(client)["hidden"] == {MOVIE: ["/img/a", "/img/b"]}
    hide(client, MOVIE, "/img/a", hidden=False)
    hide(client, MOVIE, "/img/b", hidden=False)
    s = state(client)
    assert (s["hidden"], s["hidden_version"]) == ({}, 4)


def test_no_op_changes_do_not_bump_version(client):
    hide(client, MOVIE, "/img/a")
    assert hide(client, MOVIE, "/img/a").json()["hidden_version"] == 1
    assert hide(client, MOVIE, "/img/zzz", hidden=False).json()["hidden_version"] == 1
    assert hide(client, SERIES, None, hidden=False).json()["hidden_version"] == 1


def test_unhide_all_for_one_title(client):
    hide(client, MOVIE, "/img/a")
    hide(client, MOVIE, "/img/b")
    hide(client, SERIES, "/img/c")
    r = hide(client, MOVIE, None, hidden=False)
    assert r.json()["hidden"] == {SERIES: ["/img/c"]} and r.json()["hidden_version"] == 4


@pytest.mark.parametrize(
    ("key", "image", "hidden", "message"),
    [
        ("bogus", "/img/a", True, "Not a valid title key"),
        (MOVIE, None, True, "Name the picture"),
        (MOVIE, "", True, "characters"),
        (MOVIE, "x" * (HIDDEN_IMAGE_MAX_LEN + 1), True, "characters"),
    ],
)
def test_refused(client, key, image, hidden, message):
    r = hide(client, key, image, hidden)
    assert r.status_code == 400 and message in r.json()["detail"]
    assert state(client)["hidden_version"] == 0


def test_limit_refuses_only_new_hides(client, monkeypatch):
    monkeypatch.setattr("app.main.HIDDEN_MAX", 2)
    hide(client, MOVIE, "/img/a")
    hide(client, SERIES, "/img/b")
    r = hide(client, MOVIE, "/img/c")
    assert r.status_code == 400 and "Too many hidden spoilers" in r.json()["detail"]
    assert hide(client, MOVIE, "/img/a").status_code == 200
    assert hide(client, MOVIE, "/img/a", hidden=False).status_code == 200
    assert hide(client, MOVIE, "/img/c").status_code == 200


@pytest.mark.parametrize("body", [{"key": MOVIE, "image": "/img/a"}, {"key": MOVIE, "image": "/img/a", "hidden": True, "extra": 1}])
def test_bad_body_shape(client, body):
    assert client.post("/api/hidden", json=body).status_code == 422


def test_hiding_does_not_disturb_lineup_edits(client):
    s0 = state(client)
    hide(client, MOVIE, "/img/a")
    r = client.put("/api/lineup", json={"base_instance": s0["instance"], "base_version": s0["version"], "keys": [MOVIE]})
    assert r.status_code == 200
    assert r.json() == {"instance": s0["instance"], "version": 1, "keys": [MOVIE]}
    stale = client.put("/api/lineup", json={"base_instance": s0["instance"], "base_version": 0, "keys": []})
    assert stale.status_code == 409 and stale.json() == r.json()
