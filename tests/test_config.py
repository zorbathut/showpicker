import pytest

from app.config import ErrorConfig, config_from_env


def test_jellyfin_only():
    c = config_from_env({"JELLYFIN_URL": " http://jf:8096/ ", "JELLYFIN_API_KEY": "k"})
    assert c.jellyfin.url == "http://jf:8096"
    assert c.jellyfin.user_id is None
    assert c.tmdb_key is None


def test_tmdb_only_with_blank_jellyfin_lines():
    c = config_from_env({"JELLYFIN_URL": "", "JELLYFIN_API_KEY": "", "TMDB_API_KEY": "t"})
    assert c.jellyfin is None
    assert c.tmdb_key == "t"


def test_both_with_user():
    c = config_from_env({"JELLYFIN_URL": "http://jf", "JELLYFIN_API_KEY": "k", "JELLYFIN_USER_ID": "u", "TMDB_API_KEY": "t"})
    assert c.jellyfin.user_id == "u"
    assert sorted(c.secrets()) == ["k", "t"]


@pytest.mark.parametrize(
    ("env", "mentions"),
    [
        ({"JELLYFIN_URL": "http://jf", "TMDB_API_KEY": "t"}, "JELLYFIN_API_KEY"),
        ({"JELLYFIN_API_KEY": "k", "TMDB_API_KEY": "t"}, "JELLYFIN_URL"),
        ({"JELLYFIN_USER_ID": "u", "TMDB_API_KEY": "t"}, "JELLYFIN_USER_ID"),
        ({}, "No data source"),
        ({"JELLYFIN_URL": "  ", "TMDB_API_KEY": ""}, "No data source"),
    ],
)
def test_refused(env, mentions):
    with pytest.raises(ErrorConfig, match=mentions):
        config_from_env(env)
