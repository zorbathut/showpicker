"""Configuration from environment variables, validated once at startup."""

from collections.abc import Mapping
from dataclasses import dataclass


class ErrorConfig(Exception):
    """The environment describes a configuration we refuse to run with; the message says how to fix it."""


@dataclass(frozen=True)
class JellyfinConfig:
    url: str
    key: str
    user_id: str | None


@dataclass(frozen=True)
class Config:
    jellyfin: JellyfinConfig | None
    tmdb_key: str | None

    def secrets(self) -> list[str]:
        out = [self.tmdb_key] if self.tmdb_key else []
        if self.jellyfin:
            out.append(self.jellyfin.key)
        return out


def config_from_env(env: Mapping[str, str]) -> Config:
    def read(name: str) -> str | None:
        return env.get(name, "").strip() or None

    jf_url, jf_key, jf_user, tmdb_key = read("JELLYFIN_URL"), read("JELLYFIN_API_KEY"), read("JELLYFIN_USER_ID"), read("TMDB_API_KEY")

    if bool(jf_url) != bool(jf_key):
        missing = "JELLYFIN_API_KEY" if jf_url else "JELLYFIN_URL"
        raise ErrorConfig(f"Jellyfin is half-configured: {missing} is not set. Set both JELLYFIN_URL and JELLYFIN_API_KEY, or neither.")
    if jf_user and not jf_url:
        raise ErrorConfig("JELLYFIN_USER_ID is set but Jellyfin isn't configured; set JELLYFIN_URL and JELLYFIN_API_KEY or remove it.")
    if not jf_url and not tmdb_key:
        raise ErrorConfig("No data source configured: set JELLYFIN_URL + JELLYFIN_API_KEY, and/or TMDB_API_KEY.")

    jellyfin = JellyfinConfig(url=jf_url.rstrip("/"), key=jf_key, user_id=jf_user) if jf_url and jf_key else None
    return Config(jellyfin=jellyfin, tmdb_key=tmdb_key)
