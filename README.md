# Showpicker

Put movie and show pictures on the TV so you can argue about which one to watch next.

Supports both Jellyfin and TMDB for data retrieval.

## Run

```sh
cp config.env.example config.env   # uncomment and fill in the Jellyfin and/or TMDB lines
docker compose up -d --build
```

Then open http://localhost:8000. If the container keeps restarting, the configuration was refused; `docker compose logs showpicker` says why.

## Use

* Type a title and press Enter to add the top match, or use ↑/↓ to choose another. Paste a list (one title per line) to add them all at once.
* Drag cards to reorder the lineup (press and hold first on a touch screen); ◀ ▶ on each card do the same from the keyboard. Also on each card: ↺ re-search (wrong match), ✕ remove.
* Drag pictures in Present to reorder a title's pictures (the card follows, on every screen); the notice offers Undo, and the card offers "Custom picture order · reset".
* **▶ Present** opens a fullscreen gallery: the title's logo and details, then its images six to a screen. ↑/↓ scroll a row, ←/→ (or PageUp/PageDown, for presenter clickers) change title, Esc exits. Clicking a card's picture opens it at that picture.
* **⊘** on a picture (hover a card's thumbnail, or a picture in Present) hides it as a spoiler, on every screen (the tagline in Present has one too); the notice that follows has an Undo, and a card with hidden spoilers offers "… hidden · show all". Curate on a laptop before presenting; a TV remote can't hide pictures.
* **🎲 Pick one** picks a title at random.
* The lineup is kept on the server and shared by everyone viewing the page: set it up on a laptop, open the page on the TV, and it's there. Changes show up on other screens within a few seconds. It's held in memory (as are hidden pictures), so restarting the server clears it.

Spoilers: series stills come from early episodes (specials skipped), and movie chapter images come from the first 60% of the film. This could probably be improved.

There's no auth. Anyone who can reach the port can search your library, see its artwork, and edit the shared lineup, so keep it on your LAN or put it behind your reverse proxy's auth.

## Development

```sh
uv venv -p 3.13 .venv && uv pip install -p .venv/bin/python -r requirements-dev.txt
.venv/bin/pytest                 # unit tests (fake Jellyfin/TMDB)
node --test tests/js/*.test.mjs  # lineup sync
.venv/bin/pytest -m live         # against the real servers in config.env
.venv/bin/ruff format app tests && .venv/bin/ruff check app tests
npx --yes @biomejs/biome@2.6.4 check --write app/static tests/js
```
