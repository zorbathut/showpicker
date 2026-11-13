import pytest

from app.title import ErrorTitleKey, TitleKeyJellyfin, TitleKeyTmdb, gallery_order, spread, title_key_format, title_key_parse

# Shared with test_lineup.py and test_routes.py so /api/title and /api/lineup are checked against the same key cases.
VALID_KEYS = {
    "jf:" + "a" * 32: TitleKeyJellyfin("a" * 32),
    "jf:0123abcd-0123-4567-89ab-0123456789ab": TitleKeyJellyfin("0123abcd-0123-4567-89ab-0123456789ab"),
    "tmdb:movie:157336": TitleKeyTmdb("movie", 157336),
    "tmdb:tv:95396": TitleKeyTmdb("tv", 95396),
}
INVALID_KEYS = ["", "jf:", "jf:xyz", "jf:" + "a" * 31, "tmdb:movie:", "tmdb:film:1", "tmdb:tv:12a", "tmdb:movie:1:2", "imdb:tt0816692", "jf:" + "a" * 32 + ":x"]


@pytest.mark.parametrize("key", VALID_KEYS)
def test_title_key_parse_valid(key):
    assert title_key_parse(key) == VALID_KEYS[key]


@pytest.mark.parametrize("key", VALID_KEYS)
def test_title_key_format_round_trips(key):
    assert title_key_format(title_key_parse(key)) == key


@pytest.mark.parametrize("key", INVALID_KEYS)
def test_title_key_parse_invalid(key):
    with pytest.raises(ErrorTitleKey):
        title_key_parse(key)


def test_spread_keeps_short_lists():
    assert spread([1, 2, 3], 6) == [1, 2, 3]


def test_spread_keeps_endpoints_and_spaces_evenly():
    assert spread(list(range(11)), 6) == [0, 2, 4, 6, 8, 10]


def test_spread_one():
    assert spread([5, 6, 7], 1) == [5]


def test_gallery_interleaves_backdrop_first():
    assert gallery_order(["b0", "b1", "b2", "b3"], ["s0", "s1"]) == ["b0", "s0", "b1", "s1", "b2", "b3"]


def test_gallery_more_stills_than_backdrops():
    assert gallery_order(["b0"], ["s0", "s1", "s2"]) == ["b0", "s0", "s1", "s2"]


def test_gallery_only_stills_or_empty():
    assert gallery_order([], ["s0", "s1"]) == ["s0", "s1"]
    assert gallery_order([], []) == []
