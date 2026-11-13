# Showpicker

Type in a few movie or series names. For each one, Showpicker shows the title logo, a few
backdrops and stills, and the basic facts. The point is to put the candidates on the TV and
argue about what to watch next.

* **Jellyfin**: searches your library and pulls its logos, backdrops, episode stills (series)
  or chapter images (movies). Images are proxied, so the browser never sees your API key.
* **TMDB** (optional): finds titles you don't own, and adds backdrops/logos for library
  items that only have one or two.

## Run

```sh
cp config.env.example config.env   # fill in JELLYFIN_URL / JELLYFIN_API_KEY (and TMDB_API_KEY if you like)
docker compose up -d --build
```

Then open http://localhost:8000.

## Use

* Type a title and press Enter to add the top match, or use ↑/↓ to choose another.
  Paste a list (one title per line) to add them all at once.
* On each card: ◀ ▶ reorder, ↺ re-search (wrong match), ✕ remove.
* **▶ Present** opens a fullscreen slideshow: ←/→ change title, ↑/↓ change image,
  Space pauses, Esc exits. You can also click the left or right third of the screen.
  Clicking a card or still opens the slideshow at that image.
* **🎲 Pick one** picks a title at random.
* The lineup lives in the URL (`#jf:…,tmdb:movie:…`), so **🔗 Link** shares it with another
  device. It's also saved in localStorage.

Spoilers: series stills come from early episodes (specials skipped), and movie chapter
images come from the first 60% of the film.

There's no auth. Anyone who can reach the port can search your library and see its artwork,
so keep it on your LAN or put it behind your reverse proxy's auth.
