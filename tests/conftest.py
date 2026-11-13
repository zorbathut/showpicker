import logging
from contextlib import contextmanager

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Config, JellyfinConfig
from app.main import app_create
from tests.fakes import JF_KEY, JF_URL, TMDB_KEY, FakeUpstream

CONFIG_BOTH = Config(jellyfin=JellyfinConfig(url=JF_URL, key=JF_KEY, user_id=None), tmdb_key=TMDB_KEY)
CONFIG_JF = Config(jellyfin=JellyfinConfig(url=JF_URL, key=JF_KEY, user_id=None), tmdb_key=None)
CONFIG_TMDB = Config(jellyfin=None, tmdb_key=TMDB_KEY)


@pytest.fixture
def upstream() -> FakeUpstream:
    return FakeUpstream()


class FakeClock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def connect(upstream, clock):
    """connect(config) -> a TestClient with the lifespan running, talking to `upstream`."""

    @contextmanager
    def make(config: Config):
        with TestClient(app_create(config, httpx.MockTransport(upstream.handler), clock)) as client:
            yield client

    return make


@pytest.fixture
def client(connect):
    with connect(CONFIG_BOTH) as c:
        yield c


@pytest.fixture(autouse=True)
def expected_logs(caplog):
    """Any WARNING-or-above log fails the test unless the test appends a substring of it here; every expected substring must actually be logged."""
    caplog.set_level(logging.INFO)
    expected: list[str] = []
    yield expected
    records = [*caplog.get_records("setup"), *caplog.get_records("call"), *caplog.get_records("teardown")]
    loud = [r.getMessage() for r in records if r.levelno >= logging.WARNING]
    unexpected = [m for m in loud if not any(e in m for e in expected)]
    missing = [e for e in expected if not any(e in m for m in loud)]
    assert not unexpected, f"unexpected warnings/errors logged: {unexpected}"
    assert not missing, f"expected log not seen: {missing}"
