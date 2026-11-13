"use strict";

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = "showpicker.lineup";
const SLIDE_MS = 6000;

const state = {
  lineup: [],        // ordered list of title keys ("jf:<id>", "tmdb:movie:<id>")
  details: {},       // key -> title details (or {error})
  replaceAt: null,   // index to insert the next pick at ("wrong match" flow)
};

// ------------------------------------------------------------------ utils

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let noticeTimer;
function notice(msg, ms = 5000) {
  const n = $("#notice");
  n.textContent = msg;
  n.hidden = !msg;
  clearTimeout(noticeTimer);
  if (msg && ms) noticeTimer = setTimeout(() => (n.hidden = true), ms);
}

function fmtRuntime(min) {
  if (!min) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function metaParts(d) {
  const parts = [];
  if (d.year) {
    let y = String(d.year);
    if (d.kind === "series") {
      if (d.end_year && d.end_year !== d.year) y += `–${d.end_year}`;
      else if (!d.end_year && d.status && d.status !== "Ended") y += "–";
    }
    parts.push(y);
  }
  if (d.kind === "series") parts.push(d.seasons ? `${d.seasons} season${d.seasons > 1 ? "s" : ""}` : "Series");
  else parts.push("Movie");
  const rt = fmtRuntime(d.runtime);
  if (rt) parts.push(d.kind === "series" ? `${rt}/ep` : rt);
  if (d.certification) parts.push(d.certification);
  if (d.rating) parts.push(`★ ${d.rating}`);
  return parts;
}

// Images shown under a card / in the slideshow strip.
const stripOf = (d) => (d.stills.length ? d.stills : d.backdrops.slice(1));
// Everything the slideshow cycles through.
const slidesOf = (d) => {
  const all = [...d.backdrops, ...d.stills].map((p) => p.full);
  if (!all.length && d.poster) all.push(d.poster);
  return all;
};

// ------------------------------------------------------------------ persistence

function save() {
  const h = state.lineup.map((k) => encodeURIComponent(k).replace(/%3A/g, ":")).join(",");
  history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.lineup)); } catch {}
}

function load() {
  const h = location.hash.slice(1);
  if (h) return h.split(",").map(decodeURIComponent).filter(Boolean);
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { return []; }
}

// ------------------------------------------------------------------ lineup

async function ensureDetails(key) {
  if (state.details[key] && !state.details[key].error) return state.details[key];
  try {
    state.details[key] = await api(`/api/title/${encodeURIComponent(key)}`);
  } catch (e) {
    state.details[key] = { key, error: e.message };
  }
  return state.details[key];
}

async function addKey(key) {
  const existing = state.lineup.indexOf(key);
  if (existing >= 0) {
    state.replaceAt = null;
    flashCard(existing);
    return;
  }
  if (state.replaceAt != null) {
    state.lineup.splice(Math.min(state.replaceAt, state.lineup.length), 0, key);
    state.replaceAt = null;
  } else {
    state.lineup.push(key);
  }
  save();
  render();
  await ensureDetails(key);
  render();
}

function removeAt(i) {
  state.lineup.splice(i, 1);
  save();
  render();
}

function move(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.lineup.length) return;
  [state.lineup[i], state.lineup[j]] = [state.lineup[j], state.lineup[i]];
  save();
  render();
}

function flashCard(i) {
  const el = $(`#grid .card[data-i="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ------------------------------------------------------------------ grid

function cardHtml(key, i) {
  const d = state.details[key];
  const actions = `
    <div class="actions">
      <button data-act="left" title="Move left">◀</button>
      <button data-act="right" title="Move right">▶</button>
      <button data-act="redo" title="Wrong match? Search again">↺</button>
      <button data-act="remove" title="Remove">✕</button>
    </div>`;
  if (!d) {
    return `<article class="card loading" data-i="${i}"><div class="hero"></div>
      <div class="body"><div class="meta">Loading…</div></div>${actions}</article>`;
  }
  if (d.error) {
    return `<article class="card" data-i="${i}"><div class="hero"><h2 class="logo-text">?</h2></div>
      <div class="body"><div class="meta">Couldn't load <code>${esc(key)}</code>: ${esc(d.error)}</div></div>${actions}</article>`;
  }
  const hero = d.backdrops[0]?.full || d.poster;
  const strip = stripOf(d).slice(0, 4);
  return `
    <article class="card" data-i="${i}">
      <div class="hero" data-act="show" data-img="0" ${hero ? `style="background-image:url('${esc(hero)}')"` : ""}>
        ${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="${esc(d.title)}">`
                 : `<h2 class="logo-text">${esc(d.title)}</h2>`}
        ${d.source === "jellyfin" ? `<span class="badge">In library</span>` : ""}
      </div>
      <div class="body">
        <div class="meta">${d.logo ? `<b>${esc(d.title)}</b> · ` : ""}${metaParts(d).map(esc).join(" · ")}</div>
        ${d.genres.length ? `<div class="genres">${d.genres.slice(0, 4).map(esc).join(" · ")}</div>` : ""}
        ${d.overview ? `<p class="overview">${esc(d.overview)}</p>` : ""}
        ${strip.length ? `<div class="stills">${strip.map((p) =>
          `<img loading="lazy" src="${esc(p.thumb)}" alt="" data-act="show" data-img="${slidesOf(d).indexOf(p.full)}">`).join("")}</div>` : ""}
      </div>
      ${actions}
    </article>`;
}

function render() {
  $("#grid").innerHTML = state.lineup.map(cardHtml).join("");
  $("#empty").hidden = state.lineup.length > 0;
  if (!$("#show").hidden) paintShow(false);
}

$("#grid").addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act]");
  const card = ev.target.closest(".card");
  if (!t || !card) return;
  const i = +card.dataset.i;
  switch (t.dataset.act) {
    case "remove": removeAt(i); break;
    case "left": move(i, -1); break;
    case "right": move(i, 1); break;
    case "show": openShow(i, Math.max(0, +t.dataset.img || 0)); break;
    case "redo": {
      const d = state.details[state.lineup[i]];
      removeAt(i);
      state.replaceAt = i;
      q.value = d?.title || "";
      q.focus();
      runSearch();
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
  if (res.errors?.length) notice(res.errors.join(" / "));
  return res.results;
}

async function runSearch() {
  const text = q.value.trim();
  const seq = ++searchSeq;
  if (!text) { hideSuggest(); return; }
  try {
    const results = await search(text);
    if (seq !== searchSeq) return;
    lastResults = { text, results };
    sel = results.length ? 0 : -1;
    renderSuggest();
  } catch (e) {
    if (seq === searchSeq) notice(`Search failed: ${e.message}`);
  }
}

function renderSuggest() {
  const { results } = lastResults;
  if (!results.length) {
    sug.innerHTML = `<li class="none">No matches</li>`;
  } else {
    sug.innerHTML = results.map((r, i) => `
      <li data-i="${i}" class="${i === sel ? "sel" : ""}">
        ${r.poster ? `<img src="${esc(r.poster)}" alt="">` : `<span class="noposter"></span>`}
        <span class="t">${esc(r.title)}</span>
        <span class="y">${esc(r.year ?? "")} · ${r.kind === "series" ? "Series" : "Movie"}</span>
        <span class="src ${r.source}">${r.source === "jellyfin" ? "Library" : "TMDB"}</span>
      </li>`).join("");
  }
  sug.hidden = false;
}

function hideSuggest() {
  sug.hidden = true;
  sel = -1;
}

function choose(i) {
  const r = lastResults.results[i];
  if (!r) return;
  q.value = "";
  hideSuggest();
  addKey(r.key);
}

q.addEventListener("input", debounce(runSearch, 250));

q.addEventListener("keydown", async (ev) => {
  const n = lastResults.results.length;
  if (ev.key === "ArrowDown" && !sug.hidden && n) {
    ev.preventDefault(); sel = (sel + 1) % n; renderSuggest();
  } else if (ev.key === "ArrowUp" && !sug.hidden && n) {
    ev.preventDefault(); sel = (sel - 1 + n) % n; renderSuggest();
  } else if (ev.key === "Escape") {
    hideSuggest();
    state.replaceAt = null;
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    if (lastResults.text !== text) {      // debounce hasn't caught up; search now
      ++searchSeq;
      try { lastResults = { text, results: await search(text) }; } catch (e) { notice(`Search failed: ${e.message}`); return; }
      sel = 0;
    }
    if (lastResults.results.length) choose(Math.max(sel, 0));
    else { renderSuggest(); notice(`No match for “${text}”`); }
  }
});

sug.addEventListener("mousedown", (ev) => {
  const li = ev.target.closest("li[data-i]");
  if (li) { ev.preventDefault(); choose(+li.dataset.i); }
});

q.addEventListener("blur", () => setTimeout(hideSuggest, 150));
q.addEventListener("focus", () => { if (q.value.trim() && lastResults.text === q.value.trim()) renderSuggest(); });

// Paste a list (one title per line) to add them all, taking the top match for each.
q.addEventListener("paste", (ev) => {
  const text = ev.clipboardData?.getData("text") || "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return;
  ev.preventDefault();
  bulkAdd(lines);
});

async function bulkAdd(lines) {
  const missed = [];
  for (const [n, line] of lines.entries()) {
    notice(`Adding ${n + 1}/${lines.length}: ${line}`, 0);
    try {
      const results = await search(line);
      if (results.length) await addKey(results[0].key);
      else missed.push(line);
    } catch {
      missed.push(line);
    }
  }
  notice(missed.length ? `No match for: ${missed.join(", ")}` : `Added ${lines.length} titles. Use ↺ on a card if a match is wrong.`, 8000);
}

// ------------------------------------------------------------------ presentation mode

const show = $("#show");
const slides = show.querySelectorAll(".slide");
const ss = { i: 0, img: 0, front: 0, timer: null, paused: false, token: 0 };

function openShow(i = 0, img = 0) {
  if (!state.lineup.length) { notice("Add some titles first."); return; }
  ss.i = Math.min(i, state.lineup.length - 1);
  ss.img = img;
  ss.paused = false;
  show.hidden = false;
  document.body.classList.add("showing");
  show.requestFullscreen?.().catch(() => {});
  paintShow(true);
}

function closeShow() {
  show.hidden = true;
  document.body.classList.remove("showing");
  clearInterval(ss.timer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function currentShowDetails() {
  return state.details[state.lineup[ss.i]];
}

function paintShow(newTitle) {
  if (!state.lineup.length) { closeShow(); return; }
  ss.i = Math.min(ss.i, state.lineup.length - 1);
  const key = state.lineup[ss.i];
  const d = currentShowDetails();
  $(".counter", show).textContent = `${ss.i + 1} / ${state.lineup.length}${ss.paused ? " · paused" : ""}`;
  if (!d) { ensureDetails(key).then(() => paintShow(true)); return; }
  if (!newTitle) return;

  const logo = $(".logo", show), text = $(".logo-text", show);
  if (d.logo) {
    logo.src = d.logo; logo.alt = d.title || ""; logo.hidden = false; text.hidden = true;
  } else {
    logo.hidden = true; logo.removeAttribute("src"); text.hidden = false; text.textContent = d.title || key;
  }
  $(".meta", show).textContent = d.error ? d.error :
    [...metaParts(d), ...(d.genres.length ? [d.genres.slice(0, 3).join(", ")] : [])].join("  ·  ");
  $(".tagline", show).textContent = d.tagline || "";

  const all = d.error ? [] : slidesOf(d);
  $(".strip", show).innerHTML = all.map((u, n) => {
    const p = [...d.backdrops, ...d.stills].find((x) => x.full === u);
    return `<img src="${esc(p ? p.thumb : u)}" data-n="${n}" alt="">`;
  }).join("");
  ss.img = all.length ? ss.img % all.length : 0;
  setSlide();
  restartTimer();

  // Warm up the next title so arrowing forward is instant.
  const nextKey = state.lineup[(ss.i + 1) % state.lineup.length];
  ensureDetails(nextKey).then((nd) => { if (!nd.error) { const u = slidesOf(nd)[0]; if (u) new Image().src = u; } });
}

function setSlide() {
  const d = currentShowDetails();
  const all = d && !d.error ? slidesOf(d) : [];
  show.querySelectorAll(".strip img").forEach((im) => im.classList.toggle("on", +im.dataset.n === ss.img));
  const url = all[ss.img];
  const token = ++ss.token;
  if (!url) { slides.forEach((s) => s.classList.remove("on")); return; }
  const im = new Image();
  im.onload = im.onerror = () => {
    if (token !== ss.token) return;            // user already moved on
    const back = slides[1 - ss.front];
    back.style.backgroundImage = `url('${url.replace(/'/g, "%27")}')`;
    back.classList.add("on");
    slides[ss.front].classList.remove("on");
    ss.front = 1 - ss.front;
    if (all.length > 1) new Image().src = all[(ss.img + 1) % all.length];
  };
  im.src = url;
}

function stepImage(delta) {
  const d = currentShowDetails();
  const n = d && !d.error ? slidesOf(d).length : 0;
  if (n < 2) return;
  ss.img = (ss.img + delta + n) % n;
  setSlide();
  restartTimer();
}

function stepTitle(delta) {
  const n = state.lineup.length;
  ss.i = (ss.i + delta + n) % n;
  ss.img = 0;
  paintShow(true);
}

function restartTimer() {
  clearInterval(ss.timer);
  if (!ss.paused) ss.timer = setInterval(() => stepImage(1), SLIDE_MS);
}

function togglePause() {
  ss.paused = !ss.paused;
  restartTimer();
  paintShow(false);
}

document.addEventListener("keydown", (ev) => {
  if (show.hidden) return;
  const k = ev.key;
  if (k === "ArrowRight" || k === "PageDown" || k === "n") stepTitle(1);
  else if (k === "ArrowLeft" || k === "PageUp" || k === "p") stepTitle(-1);
  else if (k === "ArrowDown") stepImage(1);
  else if (k === "ArrowUp") stepImage(-1);
  else if (k === " ") togglePause();
  else if (k === "Escape") closeShow();
  else return;
  ev.preventDefault();
});

show.addEventListener("click", (ev) => {
  if (ev.target.closest(".close")) { closeShow(); return; }
  const thumb = ev.target.closest(".strip img");
  if (thumb) { ss.img = +thumb.dataset.n; setSlide(); restartTimer(); return; }
  // Click left/right third to change title, middle to pause.
  const x = ev.clientX / window.innerWidth;
  if (x < 0.33) stepTitle(-1);
  else if (x > 0.67) stepTitle(1);
  else togglePause();
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !show.hidden) closeShow();
});

// ------------------------------------------------------------------ toolbar

$("#present").addEventListener("click", () => openShow(0, 0));

$("#clear").addEventListener("click", () => {
  if (!state.lineup.length) return;
  const prev = [...state.lineup];
  state.lineup = [];
  save();
  render();
  notice("Cleared.", 6000);
  const n = $("#notice");
  n.innerHTML = `Cleared. <button id="undo">Undo</button>`;
  $("#undo").onclick = () => { state.lineup = prev; save(); render(); notice(""); };
});

$("#share").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    notice("Link copied.");
  } catch {
    notice(location.href, 15000);
  }
});

$("#pick").addEventListener("click", async () => {
  const n = state.lineup.length;
  if (n < 2) { notice("Add at least two titles."); return; }
  const btn = $("#pick");
  btn.disabled = true;
  const winner = Math.floor(Math.random() * n);
  const hops = n * 3 + winner;     // a few laps, then land on winner
  document.querySelectorAll(".card.winner").forEach((c) => c.classList.remove("winner"));
  for (let h = 0; h <= hops; h++) {
    document.querySelectorAll(".card").forEach((c) => c.classList.toggle("lit", +c.dataset.i === h % n));
    await new Promise((r) => setTimeout(r, 60 + 260 * (h / hops) ** 3));
  }
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("lit"));
  const card = $(`#grid .card[data-i="${winner}"]`);
  card?.classList.add("winner");
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  btn.disabled = false;
});

window.addEventListener("hashchange", () => {
  const keys = load();
  if (keys.join(",") === state.lineup.join(",")) return;
  state.lineup = keys;
  render();
  keys.forEach((k) => ensureDetails(k).then(render));
});

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    const cfg = await api("/api/config");
    if (!cfg.jellyfin && !cfg.tmdb) notice("No data source configured — set JELLYFIN_URL/JELLYFIN_API_KEY and/or TMDB_API_KEY.", 0);
    else if (!cfg.tmdb) q.placeholder = "Add something from your library… (paste a list, one per line)";
  } catch {}
  state.lineup = load();
  save();
  render();
  await Promise.all(state.lineup.map((k) => ensureDetails(k).then(render)));
})();
