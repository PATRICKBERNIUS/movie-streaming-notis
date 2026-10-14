/**
 * Movie Streaming Update API: a Cloudflare Worker.
 *
 * WHY THIS EXISTS
 * The phone app is a static web page, and anything in a static page is visible
 * to whoever opens it. We can't put the GitHub token or Watchmode key there.
 * So the page talks to this Worker, and the Worker, which runs on Cloudflare's
 * servers where secrets stay hidden, talks to GitHub and Watchmode for it.
 *
 *   phone app --(passphrase)--> THIS WORKER --(token)--> GitHub  (movies.json etc.)
 *                                           --(key)----> Watchmode
 *
 * CONFIGURATION (set in the Cloudflare dashboard, never in this file)
 *   Secrets:  GITHUB_TOKEN, WATCHMODE_API_KEY, APP_PASSPHRASE, TMDB_API_KEY
 *   Plain variables: GITHUB_OWNER, GITHUB_REPO, ALLOWED_ORIGIN
 *                    (optional: MOVIES_PATH, SERVICES_PATH, GITHUB_BRANCH)
 *
 * ROUTES
 *   GET    /api/health                    no auth; "is it deployed?" check
 *   GET    /api/data                      { movies, services }
 *   POST   /api/movies   {title, year, tmdb_id}  add a movie (rejects duplicate titles)
 *   PATCH  /api/movies   {updates:[{title, year, tmdb_id}]}  set year/TMDB id on many at once
 *   DELETE /api/movies?title=...          remove a movie
 *   PUT    /api/services {services:[..]}  replace the subscribed-services list
 *   GET    /api/search?q=..&year=..       TMDB matches, for suggestions while typing
 *   GET    /api/check?title=..&year=..&tmdb_id=..   which of MY services stream this movie
 *   GET    /api/poster?title=..&year=..&tmdb_id=..  { url } of a TMDB poster image, or null
 *
 * A movie in movies.json looks like { title, year, tmdb_id }. year and tmdb_id
 * may be null. tmdb_id pins down exactly which film we mean.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Build a JSON response. CORS headers are added in one place (see fetch below). */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GitHub's API returns file contents as base64. atob/btoa only handle plain
 * Latin-1 text, so we go through bytes to keep characters like "é" intact.
 */
function b64decodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64encodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// CORS
//
// Browsers refuse to let a page on one website (your GitHub Pages URL) read
// responses from a different website (this Worker) unless the Worker says
// "that origin is allowed". That rule is CORS. Before any request that carries
// custom headers (ours carries X-Passphrase), the browser first sends an
// OPTIONS "preflight" request to ask permission.
//
// CORS only controls which *web pages* may call us. It is not security by
// itself, since curl ignores it. The passphrase is the real gate.
// ---------------------------------------------------------------------------

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Passphrase",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Echo the origin back only if it is on our list. Otherwise send no
  // Allow-Origin header and the browser blocks the page from reading the reply.
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Auth: one shared passphrase, sent in the X-Passphrase header.
// ---------------------------------------------------------------------------

/**
 * Compare two strings without bailing out at the first different character
 * (which would leak, via timing, how much of a guess was right). Hashing both
 * first gives equal-length byte arrays to compare.
 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function requireAuth(request, env) {
  if (!env.APP_PASSPHRASE) {
    throw new HttpError(500, "Server is missing the APP_PASSPHRASE secret.");
  }
  const supplied = request.headers.get("X-Passphrase") || "";
  if (!(await safeEqual(supplied, env.APP_PASSPHRASE))) {
    throw new HttpError(401, "Wrong or missing passphrase.");
  }
}

// ---------------------------------------------------------------------------
// GitHub: the repo is our database. Two files, read and written through the
// "contents" API.
// ---------------------------------------------------------------------------

function githubUrl(env, path) {
  const branch = env.GITHUB_BRANCH ? `?ref=${encodeURIComponent(env.GITHUB_BRANCH)}` : "";
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}${branch}`;
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    // GitHub rejects API requests that have no User-Agent. Browsers add one
    // automatically; Workers don't, so we set it ourselves.
    "User-Agent": "movie-streaming-update-worker",
  };
}

/** Read a JSON file. Returns { data, sha }. sha is the file's version id. */
async function readJsonFile(env, path, fallback) {
  const res = await fetch(githubUrl(env, path), { headers: githubHeaders(env) });
  if (res.status === 404) return { data: fallback, sha: null };
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, "GitHub rejected the token. Check GITHUB_TOKEN and its repo permissions.");
  }
  if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status} reading ${path}.`);
  const file = await res.json();
  try {
    return { data: JSON.parse(b64decodeUtf8(file.content)), sha: file.sha };
  } catch {
    throw new HttpError(502, `${path} in the repo is not valid JSON.`);
  }
}

/**
 * Read-modify-write, safely.
 *
 * To update a file, GitHub requires the `sha` of the version you are replacing.
 * If someone else changed the file in the meantime (say the Friday job, or your
 * phone and laptop at once), the sha is stale and GitHub answers 409 Conflict
 * instead of silently overwriting their change. We respond by re-reading the
 * fresh file, re-applying our change, and trying again.
 *
 * `mutate(data)` receives the current contents and returns the new contents.
 * It may throw an HttpError to abort (e.g. "duplicate title").
 */
async function updateJsonFile(env, path, fallback, mutate, message) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, sha } = await readJsonFile(env, path, fallback);
    const updated = mutate(data);

    const body = {
      message,
      content: b64encodeUtf8(JSON.stringify(updated, null, 2) + "\n"),
    };
    if (sha) body.sha = sha;
    if (env.GITHUB_BRANCH) body.branch = env.GITHUB_BRANCH;

    const res = await fetch(githubUrl(env, path).split("?")[0], {
      method: "PUT",
      headers: { ...githubHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) return updated;
    if (res.status === 409 && attempt < 3) continue; // stale sha: re-read and retry
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(502, "GitHub rejected the token. It needs Contents: Read and write on this repo.");
    }
    throw new HttpError(502, `GitHub returned ${res.status} saving ${path}.`);
  }
  throw new HttpError(409, "The list kept changing underneath us. Try again.");
}

const moviesPath = (env) => env.MOVIES_PATH || "movies.json";
const servicesPath = (env) => env.SERVICES_PATH || "streaming_services.json";

// ---------------------------------------------------------------------------
// Watchmode: "which streaming services have this title?"
// ---------------------------------------------------------------------------

function normalizeName(name) {
  // "Disney+" -> "disney", "Apple TV+" -> "apple tv", "AMC+" -> "amc"
  return name.toLowerCase().replace(/\+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Does Watchmode's service name refer to the service I subscribe to?
 *
 * Exact match, or one name is the other followed by a space and more words:
 * "Peacock Premium" matches "Peacock", "Tubi TV" matches "Tubi".
 * A plain "contains" check is deliberately avoided, because "max" is inside
 * "Cinemax", which would wrongly report Cinemax titles as available on Max.
 */
function sameService(watchmodeName, mine) {
  const a = normalizeName(watchmodeName || "");
  const b = normalizeName(mine || "");
  if (!a || !b) return false;
  return a === b || a.startsWith(b + " ") || b.startsWith(a + " ");
}

/** GET from Watchmode. Returns null on 404 so callers can fall back. */
async function watchmodeGet(env, url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (res.status === 401) throw new HttpError(502, "Watchmode rejected the API key.");
  if (res.status === 429) throw new HttpError(429, "Watchmode rate limit reached. Try again later.");
  if (!res.ok) throw new HttpError(502, `Watchmode returned ${res.status}.`);
  return res.json();
}

async function checkAvailability(env, title, year, tmdbId, myServices) {
  const key = encodeURIComponent(env.WATCHMODE_API_KEY);
  const sourcesUrl = (id) =>
    `https://api.watchmode.com/v1/title/${id}/sources/?apiKey=${key}&regions=US`;

  // Watchmode accepts TMDB IDs as "movie-<id>". When we know the TMDB ID we
  // skip the search: one Watchmode call instead of two, and no chance of
  // picking the wrong film. 404 means Watchmode hasn't linked that ID; then
  // fall through to searching by title like before.
  let sources = tmdbId ? await watchmodeGet(env, sourcesUrl(`movie-${tmdbId}`)) : null;

  if (!sources) {
    const search = await watchmodeGet(
      env,
      `https://api.watchmode.com/v1/search/?apiKey=${key}&search_field=name&search_value=${encodeURIComponent(title)}`
    );
    const movies = ((search && search.title_results) || []).filter((r) => r.type === "movie");
    if (movies.length === 0) return { matched: false, availableOn: [] };

    // Prefer the result with the right year; otherwise take Watchmode's top hit.
    const match = (year && movies.find((m) => String(m.year) === String(year))) || movies[0];
    sources = (await watchmodeGet(env, sourcesUrl(match.id))) || [];
  }

  // type "sub" = included with a subscription (as opposed to rent / buy / free).
  const availableOn = myServices.filter((mine) =>
    sources.some((s) => s.type === "sub" && sameService(s.name, mine))
  );
  return { matched: true, availableOn };
}

// ---------------------------------------------------------------------------
// TMDB: posters, and the suggestions shown while you type a title.
// ---------------------------------------------------------------------------

// TMDB's public image server needs no key, so the page loads images directly.
// The size in the path is the width in pixels: w342 is sharp in the 2-column
// grid, w92 is plenty for the small thumbnails next to a suggestion.
const tmdbImage = (path, size) => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);

/** GET from TMDB's API. Returns null on 404 so callers can fall back. */
async function tmdbGet(env, path, params = {}) {
  if (!env.TMDB_API_KEY) {
    throw new HttpError(500, "Server is missing the TMDB_API_KEY secret.");
  }
  const query = new URLSearchParams({ api_key: env.TMDB_API_KEY, ...params });
  const res = await fetch(`https://api.themoviedb.org/3${path}?${query}`);
  if (res.status === 404) return null;
  if (res.status === 401) throw new HttpError(502, "TMDB rejected the API key.");
  if (res.status === 429) throw new HttpError(429, "TMDB rate limit reached. Try again later.");
  if (!res.ok) throw new HttpError(502, `TMDB returned ${res.status}.`);
  return res.json();
}

/** Search TMDB for movies by title. Best match first, as TMDB ranks them. */
async function searchTmdb(env, query, year) {
  const params = { query };
  if (year) params.year = year;
  const data = await tmdbGet(env, "/search/movie", params);
  return ((data && data.results) || []).slice(0, 8).map((m) => ({
    tmdb_id: m.id,
    title: m.title,
    // release_date is "YYYY-MM-DD", or "" when TMDB doesn't know it.
    year: (m.release_date || "").slice(0, 4) || null,
    thumb: tmdbImage(m.poster_path, "w92"),
  }));
}

async function findPoster(env, title, year, tmdbId) {
  // Exact film when we know its TMDB ID; otherwise the top search result,
  // the same lookup the Streamlit app used.
  if (tmdbId) {
    const movie = await tmdbGet(env, `/movie/${tmdbId}`);
    if (movie) return tmdbImage(movie.poster_path, "w342");
  }
  const params = { query: title };
  if (year) params.year = year;
  const data = await tmdbGet(env, "/search/movie", params);
  const top = ((data && data.results) || [])[0];
  return top ? tmdbImage(top.poster_path, "w342") : null;
}

// ---------------------------------------------------------------------------
// Input validation (never trust what the browser sends)
// ---------------------------------------------------------------------------

function cleanTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new HttpError(400, "A title is required.");
  if (title.length > 200) throw new HttpError(400, "Title is too long.");
  return title;
}

function cleanYear(value) {
  if (value === null || value === undefined || value === "") return null;
  const year = String(value).trim();
  if (!/^\d{4}$/.test(year)) throw new HttpError(400, "Year must be four digits, like 2024.");
  return year;
}

function cleanTmdbId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value).trim();
  // Digits only: the ID ends up inside API URLs, so nothing else gets through.
  if (!/^\d{1,10}$/.test(id)) throw new HttpError(400, "tmdb_id must be a number.");
  return Number(id);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true });
  }

  // Everything below needs the passphrase.
  await requireAuth(request, env);

  if (pathname === "/api/data" && method === "GET") {
    const [movies, services] = await Promise.all([
      readJsonFile(env, moviesPath(env), []),
      readJsonFile(env, servicesPath(env), { services: [] }),
    ]);
    return json({ movies: movies.data, services: services.data.services || [] });
  }

  if (pathname === "/api/movies" && method === "POST") {
    const body = await readBody(request);
    const title = cleanTitle(body.title);
    const year = cleanYear(body.year);
    const tmdb_id = cleanTmdbId(body.tmdb_id);
    const movies = await updateJsonFile(
      env,
      moviesPath(env),
      [],
      (list) => {
        if (list.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
          throw new HttpError(409, `"${title}" is already on your list.`);
        }
        return [...list, { title, year, tmdb_id }];
      },
      `Add '${title}' via Movie Streaming Update`
    );
    return json({ movies });
  }

  // Set year and TMDB id on many movies in one save. Used by "Match years",
  // so 60 fixes become one commit instead of 60. Titles are not changed, so
  // the duplicate rule and the Friday job's history are unaffected.
  if (pathname === "/api/movies" && method === "PATCH") {
    const body = await readBody(request);
    if (!Array.isArray(body.updates) || body.updates.length > 1000) {
      throw new HttpError(400, "updates must be a list of { title, year, tmdb_id }.");
    }
    const updates = new Map(
      body.updates.map((u = {}) => [
        cleanTitle(u && u.title).toLowerCase(),
        { year: cleanYear(u && u.year), tmdb_id: cleanTmdbId(u && u.tmdb_id) },
      ])
    );
    let changed = 0;
    const movies = await updateJsonFile(
      env,
      moviesPath(env),
      [],
      (list) => {
        changed = 0;
        return list.map((m) => {
          const u = updates.get(m.title.toLowerCase());
          if (!u) return m; // not in this batch, or removed since: leave as is
          changed++;
          return { ...m, ...u };
        });
      },
      `Match years for ${updates.size} movie(s) via Movie Streaming Update`
    );
    return json({ movies, changed });
  }

  if (pathname === "/api/movies" && method === "DELETE") {
    const title = cleanTitle(url.searchParams.get("title"));
    const movies = await updateJsonFile(
      env,
      moviesPath(env),
      [],
      (list) => {
        const kept = list.filter((m) => m.title.toLowerCase() !== title.toLowerCase());
        if (kept.length === list.length) throw new HttpError(404, `"${title}" is not on your list.`);
        return kept;
      },
      `Remove '${title}' via Movie Streaming Update`
    );
    return json({ movies });
  }

  if (pathname === "/api/services" && method === "PUT") {
    const body = await readBody(request);
    if (!Array.isArray(body.services) || body.services.some((s) => typeof s !== "string")) {
      throw new HttpError(400, "services must be an array of strings.");
    }
    const services = [...new Set(body.services.map((s) => s.trim()).filter(Boolean))];
    await updateJsonFile(
      env,
      servicesPath(env),
      { services: [] },
      () => ({ services }),
      "Update streaming services via Movie Streaming Update"
    );
    return json({ services });
  }

  if (pathname === "/api/search" && method === "GET") {
    const query = cleanTitle(url.searchParams.get("q"));
    const year = cleanYear(url.searchParams.get("year"));
    return json({ results: await searchTmdb(env, query, year) });
  }

  if (pathname === "/api/check" && method === "GET") {
    const title = cleanTitle(url.searchParams.get("title"));
    const year = cleanYear(url.searchParams.get("year"));
    const tmdbId = cleanTmdbId(url.searchParams.get("tmdb_id"));
    const { data } = await readJsonFile(env, servicesPath(env), { services: [] });
    const myServices = data.services || [];
    if (myServices.length === 0) {
      throw new HttpError(400, "Pick at least one streaming service first.");
    }
    return json({ title, year, ...(await checkAvailability(env, title, year, tmdbId, myServices)) });
  }

  if (pathname === "/api/poster" && method === "GET") {
    const title = cleanTitle(url.searchParams.get("title"));
    const year = cleanYear(url.searchParams.get("year"));
    const tmdbId = cleanTmdbId(url.searchParams.get("tmdb_id"));
    const response = json({ title, year, url: await findPoster(env, title, year, tmdbId) });
    // A movie's poster doesn't change, so let the phone keep the answer for a
    // week instead of asking again on every visit. "private" means only your
    // browser may store it, never a shared cache in between.
    response.headers.set("Cache-Control", "private, max-age=604800");
    return response;
  }

  throw new HttpError(404, "No such route.");
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    // The browser's permission check (see CORS above). It needs no auth.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ error: err.message }, err.status);
      } else {
        // Log the detail for us, but tell the client nothing sensitive.
        console.error(err);
        response = json({ error: "Unexpected server error." }, 500);
      }
    }

    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
};
