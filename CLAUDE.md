# Showpicker

A small web app for choosing what to watch: type in some movie/series names and it shows each one's title logo, backdrops, and stills, with a fullscreen presentation mode for putting the candidates on a TV.

## Layout

- `app/main.py` — `app_create(config, transport)` builds the FastAPI app: routes, the title cache, the shared in-memory lineup, and the composition of library details with TMDB artwork. `app_from_env()` is the `uvicorn --factory` entry point.
- `app/config.py` — env → `Config`, refusing incomplete configurations at startup.
- `app/jellyfin.py`, `app/tmdb.py` — one class per source; both produce `TitleDraft`s.
- `app/title.py` — the shared title shape: key format (`title_key_parse`/`title_key_format`; persisted, since old saved links carry keys), search hits, image pairs, gallery ordering.
- `app/redact.py` — `describe()`, for error text that may carry keys.
- `app/static/` — the frontend: plain JavaScript ES modules (no build step, no framework). `sync.js` keeps the shared lineup and hidden (spoiler) pictures in step with the server (tested in `tests/js/` with `node --test`); `app.js` is everything else.
- `tests/` — pytest against `httpx.MockTransport` fakes of both upstreams (`tests/fakes.py`); `-m live` runs against the real servers in `config.env`.
- `config.env` (git-ignored; template `config.env.example`) — `JELLYFIN_URL`, `JELLYFIN_API_KEY`, optional `JELLYFIN_USER_ID`, `TMDB_API_KEY`. The user prefers non-dotfile names for config.
- Runs as a Docker container: `docker compose up -d --build`, serves on port 8000.

## Commands

- Tests: `node --test tests/js/*.test.mjs` and `.venv/bin/pytest` (Python 3.13 venv: `uv venv -p 3.13 .venv && uv pip install -p .venv/bin/python -r requirements-dev.txt`); live: `.venv/bin/pytest -m live`.
- Python format/lint: `.venv/bin/ruff format app tests && .venv/bin/ruff check app tests`.
- JS/CSS/HTML format/lint: `npx --yes @biomejs/biome@2.6.4 check --write app/static tests/js`.
- Outside `sync.js` the frontend has no unit tests; verify UI changes with a headless-Chrome smoke run against the container and say so.

## Standards

@CLAUDE-general.md
@CLAUDE-python.md
@CLAUDE-typescript.md

CLAUDE-typescript.md applies to the frontend even though it is plain JavaScript rather than TypeScript: its naming, error-handling, async, style, and composition rules hold as written; the sections about the type system (`strict`, casts, unions) have no JavaScript equivalent and don't apply.

## Secrets

The Jellyfin and TMDB keys must never reach the browser, logs, or error messages. httpx embeds request URLs (which can carry the TMDB v3 `api_key`) in its exception text and INFO logs; route any upstream error text through `describe()` in `app/redact.py`.
