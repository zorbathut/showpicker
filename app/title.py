"""The title shape shared by both sources: keys, images, search hits, and the payload the frontend renders."""

import re
from dataclasses import asdict, dataclass, field
from typing import Literal, assert_never

# One width for "full" images regardless of source: a Present-mode gallery cell is ~620 CSS px at 1080p and ~1240 device px on a 4K TV, and six or more load at once.
IMAGE_FULL_W = 1280
IMAGE_THUMB_W = 640

MAX_BACKDROPS = 8
MAX_STILLS = 6

JF_ID_RE = re.compile(r"^[0-9a-fA-F-]{32,36}$")


class ErrorTitleKey(ValueError):
    """A title key that doesn't match any known format (user-supplied input)."""


@dataclass(frozen=True)
class TitleKeyJellyfin:
    item_id: str


@dataclass(frozen=True)
class TitleKeyTmdb:
    media: Literal["movie", "tv"]
    tmdb_id: int


TitleKey = TitleKeyJellyfin | TitleKeyTmdb


# Title keys are `jf:<item id>` or `tmdb:movie|tv:<id>`. Old saved links (URL hashes) and localStorage carry them, so the format is persisted: parse and format must stay inverses (pinned by a test).
def title_key_parse(key: str) -> TitleKey:
    parts = key.split(":")
    if len(parts) == 2 and parts[0] == "jf" and JF_ID_RE.match(parts[1]):
        return TitleKeyJellyfin(parts[1])
    if len(parts) == 3 and parts[0] == "tmdb" and parts[1] in ("movie", "tv") and parts[2].isdigit():
        return TitleKeyTmdb(parts[1], int(parts[2]))
    raise ErrorTitleKey(f"Not a valid title key: {key!r} (expected jf:<id> or tmdb:movie|tv:<id>)")


def title_key_format(key: TitleKey) -> str:
    match key:
        case TitleKeyJellyfin(item_id):
            return f"jf:{item_id}"
        case TitleKeyTmdb(media, tmdb_id):
            return f"tmdb:{media}:{tmdb_id}"
        case _:
            assert_never(key)


def pic(full: str, thumb: str) -> dict:
    return {"full": full, "thumb": thumb}


def spread(seq: list, n: int) -> list:
    """Pick n items evenly spaced through seq, keeping the first and last."""
    if len(seq) <= n:
        return list(seq)
    if n == 1:
        return [seq[0]]
    return [seq[round(i * (len(seq) - 1) / (n - 1))] for i in range(n)]


def year_of(date: str | None) -> int | None:
    if date and len(date) >= 4 and date[:4].isdigit():
        return int(date[:4])
    return None


def gallery_order(backdrops: list[dict], stills: list[dict]) -> list[dict]:
    """Interleave backdrops and stills, backdrop first, so the first screen of Present mode shows both key art and actual scenes."""
    out = []
    for i in range(max(len(backdrops), len(stills))):
        out.extend(seq[i] for seq in (backdrops, stills) if i < len(seq))
    return out


@dataclass(frozen=True)
class SearchHit:
    key: TitleKey
    source: Literal["jellyfin", "tmdb"]
    kind: Literal["movie", "series"]
    title: str | None
    year: int | None
    poster: str | None

    def payload(self) -> dict:
        return {**asdict(self), "key": title_key_format(self.key)}


@dataclass
class TitleInfo:
    """Descriptive metadata; every field is genuinely optional, since either source may lack any of it."""

    title: str | None = None
    year: int | None = None
    end_year: int | None = None
    status: str | None = None
    tagline: str | None = None
    overview: str | None = None
    genres: list[str] = field(default_factory=list)
    certification: str | None = None
    runtime: int | None = None
    seasons: int | None = None
    logo: str | None = None
    poster: str | None = None


@dataclass
class TitleDraft:
    """A title as one source sees it, before composition (TMDB top-up, gallery ordering) turns it into the payload."""

    key: TitleKey
    source: Literal["jellyfin", "tmdb"]
    kind: Literal["movie", "series"]
    info: TitleInfo
    backdrops: list[dict]
    stills: list[dict]
    title_art: dict | None  # landscape key art with the title on it; leads the gallery
    tmdb_id: str | None  # a library item's TMDB id, used to top up its artwork
    degraded: bool = False  # part of the artwork failed to load (and was logged); don't cache this result for long

    def payload(self) -> dict:
        gallery = ([self.title_art] if self.title_art else []) + gallery_order(self.backdrops[:MAX_BACKDROPS], self.stills[:MAX_STILLS])
        title_art = self.title_art["full"] if self.title_art else None
        return {"key": title_key_format(self.key), "source": self.source, "kind": self.kind, **asdict(self.info), "gallery": gallery, "title_art": title_art}
