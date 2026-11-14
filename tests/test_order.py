import pytest

from app.main import HIDDEN_IMAGE_MAX_LEN, ORDER_IMAGES_MAX
from tests.fakes import MOVIE_ID, SERIES_ID

MOVIE = f"jf:{MOVIE_ID}"
SERIES = f"jf:{SERIES_ID}"


def set_order(client, key, images):
    return client.post("/api/order", json={"key": key, "images": images})


def state(client):
    return client.get("/api/lineup").json()


def test_starts_empty(client):
    s = state(client)
    assert (s["order"], s["order_version"]) == ({}, 0)


def test_set_and_clear(client):
    r = set_order(client, MOVIE, ["/b", "/a"])
    assert r.status_code == 200
    assert r.json() == {"instance": state(client)["instance"], "order_version": 1, "order": {MOVIE: ["/b", "/a"]}}
    assert set_order(client, MOVIE, ["/a", "/b"]).json()["order"] == {MOVIE: ["/a", "/b"]}
    r = set_order(client, MOVIE, None)
    assert (r.json()["order"], r.json()["order_version"]) == ({}, 3)


def test_no_op_changes_do_not_bump_version(client):
    set_order(client, MOVIE, ["/b", "/a"])
    assert set_order(client, MOVIE, ["/b", "/a"]).json()["order_version"] == 1
    assert set_order(client, SERIES, None).json()["order_version"] == 1


@pytest.mark.parametrize(
    ("key", "images", "message"),
    [
        ("bogus", ["/a"], "Not a valid title key"),
        (MOVIE, [], "at least one picture"),
        (MOVIE, ["/a", "/a"], "twice"),
        (MOVIE, ["/a", ""], "characters"),
        (MOVIE, ["x" * (HIDDEN_IMAGE_MAX_LEN + 1)], "characters"),
        (MOVIE, [f"/{i}" for i in range(ORDER_IMAGES_MAX + 1)], "Too many pictures"),
    ],
)
def test_refused(client, key, images, message):
    r = set_order(client, key, images)
    assert r.status_code == 400 and message in r.json()["detail"]
    assert state(client)["order_version"] == 0


def test_total_cap_refuses_growth_but_allows_shrinking_and_clearing(client, monkeypatch):
    monkeypatch.setattr("app.main.ORDER_MAX", 4)
    s0 = state(client)
    client.put("/api/lineup", json={"base_instance": s0["instance"], "base_version": s0["version"], "keys": [MOVIE, SERIES]})
    set_order(client, MOVIE, ["/a", "/b", "/c"])
    r = set_order(client, SERIES, ["/x", "/y"])
    assert r.status_code == 400 and "Too many custom picture orders" in r.json()["detail"]
    assert set_order(client, MOVIE, ["/c", "/b", "/a"]).status_code == 200  # same size: fine
    assert set_order(client, MOVIE, ["/a"]).status_code == 200  # shrink
    assert set_order(client, SERIES, ["/x", "/y"]).status_code == 200  # now fits
    assert set_order(client, MOVIE, None).status_code == 200


@pytest.mark.parametrize("body", [{"key": MOVIE}, {"key": MOVIE, "images": ["/a"], "extra": 1}, {"key": MOVIE, "images": "/a"}])
def test_bad_body_shape(client, body):
    assert client.post("/api/order", json=body).status_code == 422


def test_ordering_does_not_disturb_lineup_or_hidden_versions(client):
    s0 = state(client)
    set_order(client, MOVIE, ["/a"])
    s1 = state(client)
    assert (s1["version"], s1["hidden_version"]) == (s0["version"], s0["hidden_version"])


def test_cap_first_drops_orders_of_titles_not_in_the_lineup(client, monkeypatch):
    monkeypatch.setattr("app.main.ORDER_MAX", 4)
    s0 = state(client)
    client.put("/api/lineup", json={"base_instance": s0["instance"], "base_version": s0["version"], "keys": [SERIES]})
    set_order(client, MOVIE, ["/a", "/b", "/c"])  # MOVIE isn't in the lineup
    r = set_order(client, SERIES, ["/x", "/y"])
    assert r.status_code == 200
    assert r.json()["order"] == {SERIES: ["/x", "/y"]}
