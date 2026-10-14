/**
 * Movie Streaming Update: the phone app.
 *
 * This page holds no secrets. Everything it knows comes from the Worker, and
 * the only thing it sends is your passphrase. That is why it is safe to serve
 * it publicly from GitHub Pages.
 */

// The Worker's address. Not a secret: the passphrase is what protects it.
const API = "https://movie-streaming-update-api.pat-bernius.workers.dev";

// Remembered on this device so you only type the passphrase once. It unlocks
// the Worker, not GitHub, so a lost phone means changing APP_PASSPHRASE in
// Cloudflare, not regenerating tokens.
const STORAGE_KEY = "msu-passphrase";
const SORT_KEY = "msu-sort";

// How many /api/check requests run at once. Each one is two Watchmode calls;
// a small number keeps a 60-movie check quick without tripping rate limits.
const CHECK_CONCURRENCY = 2;

const $ = (id) => document.getElementById(id);

let passphrase = load(STORAGE_KEY);
let movies = [];
let services = [];
let sortBy = load(SORT_KEY) || "title";
let checking = false;

// Results of the last "Check availability", keyed by lowercase title (the
// same rule the Worker uses for duplicates). Empty means "never checked",
// which is when we show one plain grid instead of three groups.
// Each value: { group: "available" | "unavailable", availableOn: [...], notFound }
let results = new Map();
const keyOf = (title) => title.toLowerCase();

// Poster image URLs, same keys. A null value means "TMDB has no poster", so
// we don't ask again. Kept outside render() so redrawing the grid (which
// happens often during a check) never re-fetches a poster.
const posters = new Map();
const POSTER_CONCURRENCY = 4;
let postersLoading = false;
let postersOff = false; // set when the Worker can't do posters at all

// ---------------------------------------------------------------------------
// Storage. Wrapped in try/catch because private browsing or locked-down
// settings can make localStorage throw; the app should still work, it just
// won't remember you.
// ---------------------------------------------------------------------------

function load(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* not remembered; fine */ }
}

// ---------------------------------------------------------------------------
// Talking to the Worker. Every call goes through api() so the passphrase
// header and error handling live in one place.
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-Passphrase": passphrase };
  if (body) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    // fetch only throws when no reply arrived at all: offline, or the browser
    // blocked the reply because this page's address isn't in ALLOWED_ORIGIN.
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }

  // The Worker always answers with JSON like { error: "..." } on failure,
  // so we can show its message directly.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  return data;
}

/** One place to decide what an error means for the user. */
function handleError(err) {
  if (err.status === 401) {
    // Passphrase changed in Cloudflare or was mistyped: forget it and ask again.
    lock("Passphrase was rejected. Enter it again.");
  } else {
    setStatus(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showLogin(message = "") {
  $("app-view").hidden = true;
  $("login-view").hidden = false;
  $("login-error").textContent = message;
  $("passphrase").focus();
}

function showApp() {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("sort-select").value = sortBy;
}

function lock(message = "") {
  passphrase = "";
  save(STORAGE_KEY, "");
  movies = [];
  services = [];
  results = new Map();
  postersOff = false; // give posters another try after you log back in
  showLogin(message);
}

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("is-error", isError);
}

/** Take a fresh { movies, services } from the Worker and redraw everything. */
function applyData(data) {
  movies = data.movies;
  services = data.services;
  renderServices();
  render();
  loadPosters();
}

// ---------------------------------------------------------------------------
// Drawing the movie list
// ---------------------------------------------------------------------------

function sortMovies(list) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  if (sortBy === "title") return [...list].sort(byTitle);
  // Year: newest first; movies without a year go last, in title order.
  return [...list].sort((a, b) => {
    if (a.year && b.year && a.year !== b.year) return Number(b.year) - Number(a.year);
    if (a.year && !b.year) return -1;
    if (!a.year && b.year) return 1;
    return byTitle(a, b);
  });
}

function render() {
  const container = $("results");
  container.replaceChildren();

  if (movies.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Your list is empty. Add a movie above.";
    container.append(p);
    return;
  }

  const sorted = sortMovies(movies);

  // Never checked: one plain grid.
  if (results.size === 0 && !checking) {
    container.append(makeGrid(sorted));
    return;
  }

  // Checked (or checking): split into the three groups. A movie with no
  // result yet, including one added after the check, is "not checked yet".
  const groups = [
    { label: "Available", items: [] },
    { label: "Not on your services", items: [] },
    { label: "Not checked yet", items: [] },
  ];
  for (const movie of sorted) {
    const r = results.get(keyOf(movie.title));
    const index = !r ? 2 : r.group === "available" ? 0 : 1;
    groups[index].items.push(movie);
  }

  for (const { label, items } of groups) {
    if (items.length === 0) continue;
    const section = document.createElement("section");
    section.className = "group";
    const h2 = document.createElement("h2");
    h2.textContent = `${label} (${items.length})`;
    section.append(h2, makeGrid(items));
    container.append(section);
  }
}

function makeGrid(list) {
  const ul = document.createElement("ul");
  ul.className = "grid";
  for (const movie of list) ul.append(makeCard(movie));
  return ul;
}

function makeCard(movie) {
  // Built with createElement + textContent rather than innerHTML. A title is
  // text someone typed; innerHTML would run it as HTML, so a title like
  // <img onerror=...> could execute code. textContent never does.
  const li = document.createElement("li");
  li.className = "card";
  // Lets showPoster() find this card later without redrawing the whole grid.
  li.dataset.key = keyOf(movie.title);

  const poster = document.createElement("div");
  poster.className = "poster";
  const url = posters.get(li.dataset.key);
  if (url) {
    poster.classList.add("has-image");
    poster.append(posterImage(url));
  }
  poster.append(span("title", movie.title));
  if (movie.year) poster.append(span("year", movie.year));

  const r = results.get(keyOf(movie.title));
  if (r && r.availableOn.length) poster.append(span("where", r.availableOn.join(" · ")));
  if (r && r.notFound) poster.append(span("year", "Not found on Watchmode"));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${movie.title}`);
  remove.addEventListener("click", () => removeMovie(movie.title, remove));

  li.append(poster, remove);
  return li;
}

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function posterImage(url) {
  const img = document.createElement("img");
  img.src = url;
  // alt="" because the title is already written on the card; a screen reader
  // would otherwise read every title twice.
  img.alt = "";
  // loading=lazy: the browser only downloads images that are near the screen,
  // so opening the app doesn't pull 60 posters over mobile data at once.
  img.loading = "lazy";
  img.className = "poster-img";
  // If the image fails, fall back to the plain tile rather than a broken icon.
  img.addEventListener("error", () => {
    img.parentElement?.classList.remove("has-image");
    img.remove();
  });
  return img;
}

/** Put a newly arrived poster into its card(s) without redrawing the grid. */
function showPoster(key) {
  const url = posters.get(key);
  if (!url) return;
  for (const card of document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`)) {
    const poster = card.querySelector(".poster");
    if (poster.querySelector("img")) continue;
    poster.classList.add("has-image");
    poster.prepend(posterImage(url));
  }
}

/**
 * Fetch posters for every movie that doesn't have one yet, a few at a time
 * (same shared-queue idea as checkAll). Posters are decoration, so failures
 * stay quiet unless the Worker can't do posters at all.
 */
async function loadPosters() {
  if (postersLoading || postersOff) return;
  postersLoading = true;

  const queue = sortMovies(movies).filter((m) => !posters.has(keyOf(m.title)));

  async function worker() {
    while (queue.length && !postersOff && passphrase) {
      const movie = queue.shift();
      const key = keyOf(movie.title);
      try {
        const params = new URLSearchParams({ title: movie.title });
        if (movie.year) params.set("year", movie.year);
        const r = await api(`/api/poster?${params}`);
        posters.set(key, r.url);
        showPoster(key);
      } catch (err) {
        if (err.status === 401) {
          handleError(err);
          return;
        }
        if (err.status >= 500 || err.status === 429 || err.status === 0) {
          // Missing TMDB key, bad key, rate limit, or offline: every poster
          // would fail the same way, so stop and say why once.
          postersOff = true;
          setStatus(`Posters unavailable: ${err.message}`, true);
          return;
        }
        posters.set(key, null); // e.g. a 400 for one odd title; skip it
      }
    }
  }

  await Promise.all(Array.from({ length: POSTER_CONCURRENCY }, worker));
  postersLoading = false;

  // A movie added while we were busy still needs its poster.
  if (passphrase && movies.some((m) => !posters.has(keyOf(m.title)))) loadPosters();
}

// ---------------------------------------------------------------------------
// Drawing the services list
// ---------------------------------------------------------------------------

function renderServices() {
  $("services-count").textContent = `(${services.length})`;
  const list = $("services-list");
  list.replaceChildren();
  for (const name of services) {
    const li = document.createElement("li");
    li.className = "chip";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.addEventListener("click", () => saveServices(services.filter((s) => s !== name)));
    li.append(span("", name), remove);
    list.append(li);
  }
  // No services means nothing can be "available", so open the panel as a hint.
  if (services.length === 0) $("services-panel").open = true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function loadData() {
  setStatus("Loading your list…");
  try {
    applyData(await api("/api/data"));
    setStatus("");
  } catch (err) {
    handleError(err);
  }
}

async function addMovie(event) {
  // Stop the browser's default form submit, which would reload the page.
  event.preventDefault();
  const button = $("add-button");
  const title = $("add-title").value.trim();
  const year = $("add-year").value.trim();
  if (!title) return;

  // Disabling the button prevents a double tap from sending two requests.
  button.disabled = true;
  setStatus(`Adding "${title}"…`);
  try {
    // The Worker re-validates everything and enforces the duplicate rule;
    // the page just reports what it says.
    const data = await api("/api/movies", { method: "POST", body: { title, year: year || null } });
    movies = data.movies;
    render();
    loadPosters();
    $("add-form").reset();
    setStatus(`Added "${title}".`);
    $("add-title").focus();
  } catch (err) {
    handleError(err);
  } finally {
    button.disabled = false;
  }
}

async function removeMovie(title, button) {
  if (!confirm(`Remove "${title}" from your list?`)) return;
  button.disabled = true;
  setStatus(`Removing "${title}"…`);
  try {
    const data = await api(`/api/movies?title=${encodeURIComponent(title)}`, { method: "DELETE" });
    movies = data.movies;
    results.delete(keyOf(title));
    render();
    setStatus(`Removed "${title}".`);
  } catch (err) {
    button.disabled = false;
    handleError(err);
  }
}

async function addService(event) {
  event.preventDefault();
  const name = $("service-name").value.trim();
  if (!name) return;
  // The Worker only removes exact duplicates, so catch "netflix" vs "Netflix" here.
  if (services.some((s) => s.toLowerCase() === name.toLowerCase())) {
    setStatus(`${name} is already in your services.`, true);
    return;
  }
  if (await saveServices([...services, name])) $("service-form").reset();
}

/** Replace the whole services list (that is what PUT /api/services does). */
async function saveServices(next) {
  if (checking) {
    setStatus("Wait for the check to finish before changing services.", true);
    return false;
  }
  $("service-button").disabled = true;
  setStatus("Saving services…");
  try {
    const data = await api("/api/services", { method: "PUT", body: { services: next } });
    services = data.services;
    renderServices();
    // Old results were matched against the old list, so they no longer hold.
    if (results.size) {
      results = new Map();
      render();
      setStatus("Services saved. Check availability again to update the groups.");
    } else {
      setStatus("Services saved.");
    }
    return true;
  } catch (err) {
    handleError(err);
    return false;
  } finally {
    $("service-button").disabled = false;
  }
}

/**
 * Check every movie. Each card moves into its group as its answer arrives,
 * so you see progress instead of waiting on a spinner.
 *
 * CHECK_CONCURRENCY "workers" share one queue: each takes the next movie,
 * waits for its answer, then takes another. That keeps a fixed number of
 * requests in flight instead of firing all 60 at once.
 */
async function checkAll() {
  if (checking || movies.length === 0) return;
  if (services.length === 0) {
    $("services-panel").open = true;
    setStatus("Add at least one streaming service first.", true);
    return;
  }

  checking = true;
  $("check-button").disabled = true;
  results = new Map();
  render();

  const queue = sortMovies(movies);
  const total = queue.length;
  let done = 0;
  let failed = 0;
  let stopError = null; // an error that means "stop checking everything"

  async function worker() {
    while (queue.length && !stopError) {
      const movie = queue.shift();
      try {
        const params = new URLSearchParams({ title: movie.title });
        if (movie.year) params.set("year", movie.year);
        const r = await api(`/api/check?${params}`);
        results.set(keyOf(movie.title), {
          group: r.availableOn.length ? "available" : "unavailable",
          availableOn: r.availableOn,
          notFound: !r.matched,
        });
      } catch (err) {
        // Wrong passphrase, rate limit, or offline will fail for every movie,
        // so stop. Anything else only affects this one: leave it unchecked.
        if (err.status === 401 || err.status === 429 || err.status === 0) stopError = err;
        else failed++;
      }
      done++;
      setStatus(`Checking ${done} of ${total}…`);
      render();
    }
  }

  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));

  checking = false;
  $("check-button").disabled = false;
  render();

  if (stopError) {
    handleError(stopError);
  } else {
    const available = [...results.values()].filter((r) => r.group === "available").length;
    const note = failed ? ` ${failed} couldn't be checked.` : "";
    setStatus(`Done. ${available} of ${total} available on your services.${note}`, failed > 0);
  }
}

async function unlock(event) {
  event.preventDefault();
  const button = event.submitter;
  passphrase = $("passphrase").value;
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    // Fetching the list doubles as the passphrase check: if it works, we're in.
    const data = await api("/api/data");
    save(STORAGE_KEY, passphrase);
    $("login-form").reset();
    showApp();
    setStatus("");
    applyData(data);
  } catch (err) {
    passphrase = "";
    $("login-error").textContent =
      err.status === 401 ? "That passphrase didn't work." : err.message;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$("login-form").addEventListener("submit", unlock);
$("add-form").addEventListener("submit", addMovie);
$("service-form").addEventListener("submit", addService);
$("check-button").addEventListener("click", checkAll);
$("lock-button").addEventListener("click", () => lock());
$("sort-select").addEventListener("change", (e) => {
  sortBy = e.target.value;
  save(SORT_KEY, sortBy);
  render();
});

if (passphrase) {
  showApp();
  loadData();
} else {
  showLogin();
}
