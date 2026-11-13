import { syncCreate } from "./sync.js";

const OLD_STORE_KEY = "showpicker.lineup"; // where lineups lived before they moved to the server; read once for import
const POLL_MS = 3000;
const BOOT_RETRY_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const NOTICE_MS = 5000;
const NOTICE_LONG_MS = 8000;
const NOTICE_STICKY = 0;
const SHOW_IDLE_MS = 2000;
const SHOW_EAGER_IMAGES = 6;

const state = {
  lineup: [], // ordered title keys ("jf:<id>", "tmdb:movie:<id>"), mirrored from the sync module
  lineupMax: null,
  details: {}, // key -> title payload, or {error, status}
  replaceAt: null, // index the next pick goes to (the "wrong match" flow)
  undo: null, // the lineup before the last Clear, while no other edit has happened since
  winnerKey: null, // the 🎲 result, highlighted until the next pick
  hidden: {}, // title key -> ids (full URLs) of pictures hidden as spoilers, mirrored from the sync module
};

// ------------------------------------------------------------------ utils

function $(selector, root = document) {
  return root.querySelector(selector);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A CSS url() for any URL: characters that could end the string or the url() are percent-encoded.
function cssUrl(url) {
  return `url("${url.replace(/["'()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}")`;
}

class ErrorHttp extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function errorText(r) {
  if ((r.headers.get("content-type") || "").includes("application/json")) {
    const body = await r.json();
    return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
  }
  return `${r.status} ${r.statusText}`;
}

async function api(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) {
    throw new ErrorHttp(r.status, await errorText(r));
  }
  return r.json();
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let noticeTimer;
function notice(msg, ms) {
  const n = $("#notice");
  n.textContent = msg;
  n.hidden = !msg;
  clearTimeout(noticeTimer);
  if (msg && ms) {
    noticeTimer = setTimeout(() => {
      n.hidden = true;
    }, ms);
  }
}

// A notice with one action button.
function noticeAction(msg, ms, label, action) {
  notice(msg, ms);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    notice("", NOTICE_MS);
    action();
  });
  $("#notice").append(" ", button);
}

function reportError(e) {
  console.error(e);
  notice(`Something went wrong: ${e?.message ?? e}`, NOTICE_LONG_MS);
}

window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason));

// A broken image hides its cell instead of showing a broken-image icon, and says so in the console.
document.addEventListener(
  "error",
  (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.closest("#grid, #show")) {
      return;
    }
    console.warn("image failed to load:", img.src);
    if (img.matches(".show-logo")) {
      showLogoFailed();
    } else {
      (img.closest(".show-cell, .still") ?? img).hidden = true;
    }
  },
  true,
);

function fmtRuntime(min) {
  if (!min) {
    return null;
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function metaParts(d) {
  const parts = [];
  if (d.year) {
    let y = String(d.year);
    if (d.kind === "series") {
      if (d.end_year && d.end_year !== d.year) {
        y += `–${d.end_year}`;
      } else if (!d.end_year && d.status && d.status !== "Ended") {
        y += "–";
      }
    }
    parts.push(y);
  }
  if (d.kind === "series") {
    parts.push(d.seasons ? `${d.seasons} season${d.seasons > 1 ? "s" : ""}` : "Series");
  } else {
    parts.push("Movie");
  }
  const rt = fmtRuntime(d.runtime);
  if (rt) {
    parts.push(d.kind === "series" ? `${rt}/ep` : rt);
  }
  if (d.certification) {
    parts.push(d.certification);
  }
  return parts;
}

// ------------------------------------------------------------------ title details

const detailsInflight = new Map(); // key -> promise, so concurrent callers share one request

function detailsEnsure(key) {
  const have = state.details[key];
  if (have && !have.error) {
    return Promise.resolve(have);
  }
  if (!detailsInflight.has(key)) {
    detailsInflight.set(
      key,
      detailsFetch(key).finally(() => detailsInflight.delete(key)),
    );
  }
  return detailsInflight.get(key);
}

async function detailsFetch(key) {
  try {
    state.details[key] = await api(`/api/title/${encodeURIComponent(key)}`);
  } catch (e) {
    console.warn(`loading ${key} failed:`, e);
    state.details[key] = { key, error: e.message, status: e instanceof ErrorHttp ? e.status : null };
  }
  return state.details[key];
}

async function detailsLoadAll() {
  await Promise.all(
    state.lineup.map(async (key) => {
      await detailsEnsure(key);
      render();
    }),
  );
}

// ------------------------------------------------------------------ lineup

async function syncTransport(method, path, body) {
  const r = await fetch(path, method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (r.headers.get("content-type") || "").includes("application/json") ? await r.json() : null;
  return { status: r.status, body: json };
}

const sync = syncCreate(syncTransport, {
  onAdopt(keys) {
    state.lineup = [...keys];
    state.replaceAt = null;
    state.undo = null;
    render();
    detailsLoadAll().catch(reportError);
  },
  onConflict() {
    notice("The lineup changed on another screen; redo that change if you still want it.", NOTICE_LONG_MS);
  },
  onRefused(message) {
    reportError(new Error(`The server refused that lineup: ${message}`));
  },
  onHidden(map) {
    state.hidden = map;
    render();
  },
  onHideRefused(message) {
    reportError(new Error(`Couldn't hide or unhide that picture: ${message}`));
  },
  onConnection(ok, error) {
    if (!ok) {
      console.warn("lost connection to the server:", error);
    }
    const status = $("#status");
    status.textContent = ok ? "" : "Lost connection to the server; retrying…";
    status.hidden = ok;
  },
});

// Resolves true once the new lineup is on the server.
function lineupSet(keys) {
  state.lineup = keys;
  state.undo = null;
  render();
  return sync.edit(keys);
}

function lineupEdit(keys) {
  lineupSet(keys).catch(reportError);
}

function lineupAdd(key) {
  const existing = state.lineup.indexOf(key);
  if (existing >= 0) {
    state.replaceAt = null;
    cardFlash(existing);
    return false;
  }
  if (state.lineup.length >= state.lineupMax) {
    notice(`Lineup is full (${state.lineupMax}).`, NOTICE_MS);
    return false;
  }
  const keys = [...state.lineup];
  if (state.replaceAt != null) {
    keys.splice(Math.min(state.replaceAt, keys.length), 0, key);
    state.replaceAt = null;
  } else {
    keys.push(key);
  }
  lineupEdit(keys);
  const load = async () => {
    await detailsEnsure(key);
    render();
  };
  load().catch(reportError);
  return true;
}

function lineupRemove(i) {
  lineupEdit(state.lineup.filter((_, j) => j !== i));
}

function lineupMove(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.lineup.length) {
    return;
  }
  const keys = [...state.lineup];
  [keys[i], keys[j]] = [keys[j], keys[i]];
  lineupEdit(keys);
}

async function lineupAddBulk(lines) {
  const missed = [];
  let added = 0;
  let stoppedAt = null;
  for (const [n, line] of lines.entries()) {
    if (state.lineup.length >= state.lineupMax) {
      stoppedAt = line;
      break;
    }
    notice(`Adding ${n + 1}/${lines.length}: ${line}`, NOTICE_STICKY);
    try {
      const results = await search(line);
      if (results.length) {
        added += lineupAdd(results[0].key) ? 1 : 0;
      } else {
        missed.push(line);
      }
    } catch (e) {
      console.warn(`bulk add: searching “${line}” failed:`, e);
      missed.push(`${line} (${e.message})`);
    }
  }
  const parts = [`Added ${added}.`];
  if (missed.length) {
    parts.push(`No match for: ${missed.join(", ")}.`);
  }
  if (stoppedAt) {
    parts.push(`Lineup is full (${state.lineupMax}); stopped before “${stoppedAt}”.`);
  }
  if (!missed.length && !stoppedAt) {
    parts.push("Use ↺ on a card if a match is wrong.");
  }
  notice(parts.join(" "), NOTICE_LONG_MS);
}

// Lineups used to live in the URL hash and in localStorage (keys joined by commas, each URI-encoded). Bring an old one over if the server has none, and only forget it once it's safely on the server.
async function lineupImportOld() {
  const hash = location.hash.slice(1);
  let fromHash = [];
  if (hash) {
    try {
      fromHash = hash.split(",").map(decodeURIComponent).filter(Boolean);
    } catch (e) {
      console.warn("ignoring an unreadable old link:", hash, e);
    }
  }
  let fromStore = [];
  try {
    fromStore = JSON.parse(localStorage.getItem(OLD_STORE_KEY) || "[]");
  } catch (e) {
    console.warn("couldn't read the old saved lineup:", e);
  }
  const forget = () => {
    try {
      localStorage.removeItem(OLD_STORE_KEY);
    } catch (e) {
      console.warn("couldn't clear the old saved lineup:", e);
    }
    if (hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };
  const keys = [...new Set(fromHash.length ? fromHash : fromStore)];
  if (!keys.length) {
    forget();
    return;
  }
  if (state.lineup.length) {
    forget();
    if (fromHash.length) {
      noticeAction(
        `This link has an old saved lineup (${plural(keys.length, "title")}), but there's already a lineup in use.`,
        NOTICE_STICKY,
        "Replace it",
        () => lineupImport(keys, () => {}).catch(reportError),
      );
    } else {
      console.info("ignoring the old saved lineup because the server already has one:", keys);
    }
    return;
  }
  await lineupImport(keys, forget);
}

async function lineupImport(keys, onSaved) {
  // The server is the judge of which keys are still good, and their details are needed anyway. Keep keys that fail transiently.
  const details = await Promise.all(keys.map(detailsEnsure));
  const usable = keys.filter((_, i) => !details[i].error || !details[i].status || details[i].status >= 500);
  const dropped = keys.filter((k) => !usable.includes(k));
  const kept = usable.slice(0, state.lineupMax);
  if (await lineupSet(kept)) {
    onSaved();
  }
  const parts = [`Imported ${plural(kept.length, "title")} from an old saved lineup.`];
  if (dropped.length) {
    parts.push(`Skipped ${dropped.length} that no longer resolve: ${dropped.join(", ")}.`);
  }
  if (usable.length > kept.length) {
    parts.push(`Only the first ${state.lineupMax} fit.`);
  }
  notice(parts.join(" "), NOTICE_LONG_MS);
}

// Hidden-map id for a title's tagline. Picture ids are URLs, so it can't collide with one.
const HIDDEN_TAGLINE = "tagline";

// A title's pictures minus the ones hidden as spoilers. Everything that shows pictures goes through this.
function galleryOf(d) {
  const hidden = state.hidden[d.key];
  return hidden ? d.gallery.filter((p) => !hidden.includes(p.full)) : d.gallery;
}

$(".show-tagline .hide").dataset.image = HIDDEN_TAGLINE;

function taglineOf(d) {
  return state.hidden[d.key]?.includes(HIDDEN_TAGLINE) ? null : d.tagline;
}

// Hides a picture (by its id) or the tagline (HIDDEN_TAGLINE) on every screen, offering Undo.
function spoilerHide(key, id) {
  sync.hide(key, id, true).catch(reportError);
  const what = id === HIDDEN_TAGLINE ? "Tagline" : "Picture";
  noticeAction(`${what} hidden.`, NOTICE_LONG_MS, "Undo", () => sync.hide(key, id, false).catch(reportError));
}

function cardFlash(i) {
  const el = $(`#grid .card[data-i="${i}"]`);
  if (!el) {
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
}

// ------------------------------------------------------------------ grid

function hideButton(image) {
  return `<button type="button" class="hide" data-act="hide" data-image="${esc(image)}" title="Hide this picture (spoiler)">⊘</button>`;
}

function cardHtml(key, i) {
  const d = state.details[key];
  const actions = `
    <div class="actions">
      <button type="button" data-act="left" title="Move left">◀</button>
      <button type="button" data-act="right" title="Move right">▶</button>
      <button type="button" data-act="redo" title="Wrong match? Search again">↺</button>
      <button type="button" data-act="remove" title="Remove">✕</button>
    </div>`;
  const attrs = `data-i="${i}" data-key="${esc(key)}"`;
  if (!d) {
    return `<article class="card loading" ${attrs}><div class="hero"></div>
      <div class="body"><div class="meta">Loading…</div></div>${actions}</article>`;
  }
  if (d.error) {
    return `<article class="card" ${attrs}><div class="hero"><h2 class="logo-text">?</h2></div>
      <div class="body"><div class="meta">Couldn't load <code>${esc(key)}</code>: ${esc(d.error)}</div></div>${actions}</article>`;
  }
  const gallery = galleryOf(d);
  // The poster stands in only for titles that have no pictures at all; if they were all hidden, the logo stands alone.
  const hero = gallery[0]?.full || (d.gallery.length ? null : d.poster);
  const strip = gallery.slice(1, 5);
  const hiddenParts = [];
  if (d.gallery.length > gallery.length) {
    hiddenParts.push(plural(d.gallery.length - gallery.length, "picture"));
  }
  if (d.tagline && !taglineOf(d)) {
    hiddenParts.push("the tagline");
  }
  return `
    <article class="card${key === state.winnerKey ? " winner" : ""}" ${attrs}>
      <div class="hero" data-act="show" data-img="0" ${hero ? `style="background-image:${esc(cssUrl(hero))}"` : ""}>
        ${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="${esc(d.title)}">` : `<h2 class="logo-text">${esc(d.title)}</h2>`}
        ${d.source === "jellyfin" ? `<span class="badge">In library</span>` : ""}
      </div>
      <div class="body">
        <div class="meta">${d.logo ? `<b>${esc(d.title)}</b> · ` : ""}${metaParts(d).map(esc).join(" · ")}</div>
        ${hiddenParts.length ? `<button type="button" class="unhide" data-act="unhide" title="Show what was hidden as spoilers">${capitalize(hiddenParts.join(" and "))} hidden · show all</button>` : ""}
        ${d.genres.length ? `<div class="genres">${d.genres.slice(0, 4).map(esc).join(" · ")}</div>` : ""}
        ${d.overview ? `<p class="overview">${esc(d.overview)}</p>` : ""}
        ${
          strip.length
            ? `<div class="stills">${strip
                .map(
                  (p, n) =>
                    `<span class="still"><img loading="lazy" src="${esc(p.thumb)}" alt="" data-act="show" data-img="${n + 1}">${hideButton(p.full)}</span>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>
      ${actions}
    </article>`;
}

function render() {
  $("#grid").innerHTML = state.lineup.map(cardHtml).join("");
  $("#empty").hidden = state.lineup.length > 0;
  showPaint();
}

$("#grid").addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act]");
  const card = ev.target.closest(".card");
  if (!t || !card) {
    return;
  }
  const i = Number(card.dataset.i);
  switch (t.dataset.act) {
    case "remove":
      lineupRemove(i);
      break;
    case "left":
      lineupMove(i, -1);
      break;
    case "right":
      lineupMove(i, 1);
      break;
    case "show":
      showOpen(card.dataset.key, Number(t.dataset.img));
      break;
    case "hide":
      spoilerHide(card.dataset.key, t.dataset.image);
      break;
    case "unhide":
      sync.hide(card.dataset.key, null, false).catch(reportError);
      break;
    case "redo": {
      const d = state.details[state.lineup[i]];
      lineupRemove(i);
      state.replaceAt = i;
      q.value = d?.title || "";
      q.focus();
      searchRun().catch(reportError);
      break;
    }
  }
});

// ------------------------------------------------------------------ search box

const q = $("#q");
const sug = $("#suggest");
let searchSeq = 0;
let lastResults = { text: null, results: [] };
let sel = -1;

async function search(text) {
  const res = await api(`/api/search?q=${encodeURIComponent(text)}`);
  if (res.errors.length) {
    notice(res.errors.join(" / "), NOTICE_MS);
  }
  return res.results;
}

async function searchRun() {
  const text = q.value.trim();
  const seq = ++searchSeq;
  if (!text) {
    suggestHide();
    return;
  }
  try {
    const results = await search(text);
    // Expected race: the user kept typing and a newer search superseded this one.
    if (seq !== searchSeq) {
      return;
    }
    lastResults = { text, results };
    sel = results.length ? 0 : -1;
    suggestRender();
  } catch (e) {
    if (seq === searchSeq) {
      reportError(e);
    }
  }
}

async function searchEnter() {
  const text = q.value.trim();
  if (!text) {
    return;
  }
  if (lastResults.text !== text) {
    // The debounced search hasn't caught up with what was typed; search now.
    ++searchSeq;
    lastResults = { text, results: await search(text) };
    sel = 0;
  }
  if (lastResults.results.length) {
    suggestChoose(Math.max(sel, 0));
  } else {
    suggestRender();
    notice(`No match for “${text}”`, NOTICE_MS);
  }
}

function suggestRender() {
  const { results } = lastResults;
  if (!results.length) {
    sug.innerHTML = `<li class="none">No matches</li>`;
  } else {
    sug.innerHTML = results
      .map(
        (r, i) => `
      <li data-i="${i}" class="${i === sel ? "sel" : ""}">
        ${r.poster ? `<img src="${esc(r.poster)}" alt="">` : `<span class="noposter"></span>`}
        <span class="t">${esc(r.title)}</span>
        <span class="y">${esc(r.year ?? "")} · ${r.kind === "series" ? "Series" : "Movie"}</span>
        <span class="src ${r.source}">${r.source === "jellyfin" ? "Library" : "TMDB"}</span>
      </li>`,
      )
      .join("");
  }
  sug.hidden = false;
}

function suggestHide() {
  sug.hidden = true;
  sel = -1;
}

function suggestChoose(i) {
  const r = lastResults.results[i];
  if (!r) {
    return;
  }
  q.value = "";
  suggestHide();
  lineupAdd(r.key);
}

q.addEventListener(
  "input",
  debounce(() => searchRun().catch(reportError), SEARCH_DEBOUNCE_MS),
);

q.addEventListener("keydown", (ev) => {
  const n = lastResults.results.length;
  if (ev.key === "ArrowDown" && !sug.hidden && n) {
    ev.preventDefault();
    sel = (sel + 1) % n;
    suggestRender();
  } else if (ev.key === "ArrowUp" && !sug.hidden && n) {
    ev.preventDefault();
    sel = (sel - 1 + n) % n;
    suggestRender();
  } else if (ev.key === "Escape") {
    suggestHide();
    state.replaceAt = null;
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    searchEnter().catch(reportError);
  }
});

sug.addEventListener("mousedown", (ev) => {
  const li = ev.target.closest("li[data-i]");
  if (li) {
    ev.preventDefault();
    suggestChoose(Number(li.dataset.i));
  }
});

q.addEventListener("blur", () => setTimeout(suggestHide, 150));
q.addEventListener("focus", () => {
  if (q.value.trim() && lastResults.text === q.value.trim()) {
    suggestRender();
  }
});

// Paste a list (one title per line) to add them all, taking the top match for each.
q.addEventListener("paste", (ev) => {
  const lines = (ev.clipboardData?.getData("text") || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return;
  }
  ev.preventDefault();
  lineupAddBulk(lines).catch(reportError);
});

// ------------------------------------------------------------------ present mode

const show = $("#show");
const showScroll = $(".show-scroll", show);
const showGallery = $(".show-gallery", show);
// `key` is the title being presented; its index is derived from the lineup on every paint, so edits elsewhere never move the presentation to a different title. `painted` is what the gallery DOM currently shows ({key, d, sig}, where sig covers the details' state and the ids of the cells drawn): the gallery is rebuilt only when that changes, so unrelated re-renders don't disturb it.
const showState = { key: null, i: 0, painted: null, idleTimer: null };

function showIsOpen() {
  return !show.hidden;
}

function showOpen(key, imageIndex) {
  if (!state.lineup.length) {
    notice("Add some titles first.", NOTICE_MS);
    return;
  }
  showState.key = key;
  showState.painted = null;
  show.hidden = false;
  // Notices (e.g. "Picture hidden. Undo") must be visible over the presentation, including in fullscreen, where only #show is shown.
  show.append($("#status"), $("#notice"));
  document.body.classList.add("showing");
  showScroll.focus({ preventScroll: true });
  showWake();
  if (show.requestFullscreen) {
    show.requestFullscreen().catch((e) => console.info("fullscreen unavailable; presenting in the window instead:", e.message));
  }
  showPaint();
  if (imageIndex > 0) {
    showGallery.children[imageIndex]?.scrollIntoView({ block: "start" });
  }
}

function showClose() {
  show.hidden = true;
  $("#grid").before($("#status"), $("#notice"));
  document.body.classList.remove("showing");
  if (document.fullscreenElement) {
    document.exitFullscreen().catch((e) => console.warn("leaving fullscreen failed:", e));
  }
}

function showColumns(n) {
  if (n <= 2) {
    return Math.max(n, 1);
  }
  return n <= 4 ? 2 : 3;
}

function showPaint() {
  if (!showIsOpen()) {
    return;
  }
  const n = state.lineup.length;
  const found = state.lineup.indexOf(showState.key);
  // The presented title was removed elsewhere: stay at the same position in the lineup.
  showState.i = found >= 0 ? found : Math.min(showState.i, n - 1);
  showState.key = n ? state.lineup[showState.i] : null;
  $(".show-counter", show).textContent = n ? `${showState.i + 1} / ${n}` : "";

  const key = showState.key;
  const d = key ? state.details[key] : null;
  // The tagline is updated on every paint: hiding it doesn't touch the gallery.
  const tagline = d && !d.error ? taglineOf(d) : null;
  $(".show-tagline-text", show).textContent = tagline || "";
  $(".show-tagline", show).hidden = !tagline;
  const gallery = d && !d.error ? galleryOf(d) : [];
  // The poster stands in only for titles that have no pictures at all; if they were all hidden, the band stands alone.
  const posterOnly = Boolean(d && !d.error && !d.gallery.length && d.poster);
  const cells = posterOnly ? [{ full: d.poster }] : gallery;
  const ids = cells.map((p) => p.full);
  const loaded = d ? (d.error ?? "ok") : null;
  const painted = showState.painted;
  const sameTitle = painted && painted.key === key && painted.loaded === loaded && painted.posterOnly === posterOnly;
  if (sameTitle && ids.join("\n") === painted.ids.join("\n")) {
    return;
  }
  showState.painted = { key, d, loaded, posterOnly, ids };

  // Only removals (pictures hidden here or on another screen): drop those cells in place rather than rebuilding, so nothing reloads or flashes.
  if (sameTitle && isSubsequence(ids, painted.ids)) {
    const keep = new Set(ids);
    showKeepPlace(keep, () => {
      for (const cell of [...showGallery.children]) {
        if (!keep.has(cell.dataset.image)) {
          cell.remove();
        }
      }
    });
    showLayout();
    return;
  }

  const logo = $(".show-logo", show);
  const name = $(".show-name", show);
  logo.hidden = !d?.logo;
  name.hidden = Boolean(d?.logo);
  if (d?.logo) {
    logo.src = d.logo;
    logo.alt = d.title || "";
  } else {
    logo.removeAttribute("src");
    name.textContent = !key ? "The lineup is empty" : d?.title || (d ? key : "Loading…");
  }
  $(".show-meta", show).textContent = !d
    ? ""
    : d.error
      ? `Couldn't load: ${d.error}`
      : [...metaParts(d), ...(d.genres.length ? [d.genres.slice(0, 3).join(", ")] : [])].join("  ·  ");

  const rebuild = () => {
    showGallery.classList.toggle("poster-only", posterOnly);
    showGallery.innerHTML = cells
      .map(
        (p, i) =>
          `<div class="show-cell" data-image="${esc(p.full)}"><img src="${esc(p.full)}" alt="" ${i >= SHOW_EAGER_IMAGES ? 'loading="lazy"' : ""}>${posterOnly ? "" : hideButton(p.full)}</div>`,
      )
      .join("");
    showLayout();
  };
  if (sameTitle) {
    // Same title, pictures added back (Undo, "show all"): keep the viewer's place.
    showKeepPlace(new Set(ids), rebuild);
  } else {
    rebuild();
    showScroll.scrollTop = 0;
  }

  if (key && !d) {
    showLoad(key).catch(reportError);
  } else if (d) {
    showPrefetchNext().catch(reportError);
  }
}

function isSubsequence(items, of) {
  let j = 0;
  for (const item of of) {
    if (j < items.length && items[j] === item) {
      j++;
    }
  }
  return j === items.length;
}

// Column count, rows that fit on the first screen, and the blurred background all follow the cells currently in the gallery.
function showLayout() {
  const cells = [...showGallery.children];
  const cols = showColumns(cells.length);
  show.style.setProperty("--cols", cols);
  show.style.setProperty("--fit-rows", Math.min(2, Math.max(1, Math.ceil(cells.length / cols))));
  const first = showState.painted?.d && !showState.painted.d.error ? galleryOf(showState.painted.d)[0] : null;
  $(".show-bg", show).style.backgroundImage = first ? cssUrl(first.thumb) : "";
}

// Runs `mutate` (which changes the gallery's cells) without moving what the viewer is looking at: the first visible cell that survives stays at the same height on screen. At the very top, stay at the top, so the title band stays in view.
function showKeepPlace(keep, mutate) {
  if (showScroll.scrollTop === 0) {
    mutate();
    return;
  }
  const top = showScroll.getBoundingClientRect().top;
  const anchor = [...showGallery.children].find((cell) => cell.getBoundingClientRect().bottom > top && keep.has(cell.dataset.image));
  const id = anchor?.dataset.image;
  const before = anchor?.getBoundingClientRect().top;
  mutate();
  const after = id ? showGallery.querySelector(`.show-cell[data-image="${CSS.escape(id)}"]`) : null;
  if (after) {
    showScroll.scrollTop += after.getBoundingClientRect().top - before;
  }
}

showScroll.addEventListener("click", (ev) => {
  const button = ev.target.closest("[data-act=hide]");
  if (button && showState.painted) {
    spoilerHide(showState.painted.key, button.dataset.image);
  }
});

function showLogoFailed() {
  $(".show-logo", show).hidden = true;
  const name = $(".show-name", show);
  name.hidden = false;
  name.textContent = showState.painted?.d?.title || "";
}

async function showLoad(key) {
  await detailsEnsure(key);
  showPaint();
}

// Warm up the next title so stepping forward is instant.
async function showPrefetchNext() {
  const nextKey = state.lineup[(showState.i + 1) % state.lineup.length];
  const next = await detailsEnsure(nextKey);
  if (!next.error) {
    for (const p of galleryOf(next).slice(0, SHOW_EAGER_IMAGES)) {
      new Image().src = p.full;
    }
  }
}

function showStepTitle(delta) {
  const n = state.lineup.length;
  if (!n) {
    return;
  }
  showState.key = state.lineup[(showState.i + delta + n) % n];
  showPaint();
}

function showStepRow(delta) {
  const cell = showGallery.firstElementChild;
  const gap = Number.parseFloat(getComputedStyle(showGallery).rowGap) || 0;
  const step = cell ? cell.offsetHeight + gap : showScroll.clientHeight / 2;
  showScroll.scrollBy({ top: delta * step, behavior: "smooth" });
}

// Controls and cursor appear on mouse movement (or a touch) and fade after a moment, so they don't sit over the images on a TV.
function showWake() {
  show.classList.add("awake");
  clearTimeout(showState.idleTimer);
  showState.idleTimer = setTimeout(() => show.classList.remove("awake"), SHOW_IDLE_MS);
}

show.addEventListener("mousemove", showWake);
show.addEventListener("pointerdown", showWake, true);

document.addEventListener("keydown", (ev) => {
  if (!showIsOpen() || ev.altKey || ev.ctrlKey || ev.metaKey) {
    return;
  }
  const k = ev.key;
  if (k === "ArrowRight" || k === "PageDown" || k === "n") {
    showStepTitle(1);
  } else if (k === "ArrowLeft" || k === "PageUp" || k === "p") {
    showStepTitle(-1);
  } else if (k === "ArrowDown") {
    showStepRow(1);
  } else if (k === "ArrowUp") {
    showStepRow(-1);
  } else if (k === "Escape") {
    showClose();
  } else {
    return;
  }
  ev.preventDefault();
});

$(".show-prev", show).addEventListener("click", () => showStepTitle(-1));
$(".show-next", show).addEventListener("click", () => showStepTitle(1));
$(".show-close", show).addEventListener("click", showClose);

document.addEventListener("fullscreenchange", () => {
  // Esc in fullscreen leaves fullscreen without a keydown reaching us; treat that as leaving the presentation.
  if (!document.fullscreenElement && showIsOpen()) {
    showClose();
  }
});

// ------------------------------------------------------------------ toolbar

$("#present").addEventListener("click", () => showOpen(state.lineup[0], 0));

$("#clear").addEventListener("click", () => {
  if (!state.lineup.length) {
    return;
  }
  const prev = [...state.lineup];
  lineupEdit([]);
  state.undo = prev;
  noticeAction("Cleared.", NOTICE_STICKY, "Undo", () => {
    if (!state.undo) {
      notice("Can't undo: the lineup has changed since.", NOTICE_MS);
      return;
    }
    lineupEdit(state.undo);
    detailsLoadAll().catch(reportError);
  });
});

let pickRunning = false;

async function pickRun() {
  const keys = [...state.lineup];
  if (keys.length < 2 || pickRunning) {
    if (keys.length < 2) {
      notice("Add at least two titles.", NOTICE_MS);
    }
    return;
  }
  pickRunning = true;
  $("#pick").disabled = true;
  try {
    const winner = Math.floor(Math.random() * keys.length);
    const hops = keys.length * 3 + winner; // a few laps, then land on the winner
    state.winnerKey = null;
    for (let h = 0; h <= hops; h++) {
      for (const c of document.querySelectorAll(".card")) {
        c.classList.toggle("lit", c.dataset.key === keys[h % keys.length]);
      }
      await sleep(60 + 260 * (h / hops) ** 3);
    }
    state.winnerKey = keys[winner];
  } finally {
    pickRunning = false;
    $("#pick").disabled = false;
    render();
  }
  const i = state.lineup.indexOf(state.winnerKey);
  if (i >= 0) {
    $(`#grid .card[data-i="${i}"]`).scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

$("#pick").addEventListener("click", () => pickRun().catch(reportError));

// ------------------------------------------------------------------ boot

async function boot() {
  for (;;) {
    try {
      const config = await api("/api/config");
      state.lineupMax = config.lineup_max;
      if (!config.tmdb) {
        q.placeholder = "Add something from your library… (paste a list, one per line)";
      }
      const server = await api("/api/lineup");
      sync.start(server);
      state.hidden = sync.hidden();
      state.lineup = [...server.keys];
      break;
    } catch (e) {
      reportError(e);
      await sleep(BOOT_RETRY_MS);
    }
  }
  render();
  setInterval(() => {
    if (!document.hidden) {
      sync.poll().catch(reportError);
    }
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      sync.poll().catch(reportError);
    }
  });
  await lineupImportOld();
  await detailsLoadAll();
}

boot().catch(reportError);
