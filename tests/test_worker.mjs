// Tests the Worker against fake GitHub / Watchmode / TMDB servers, so every
// route and error path runs without real keys or network calls.
//
// Run from the repo root:  node tests/test_worker.mjs
// (No Node installed? VS Code includes one. In cmd:
//  set ELECTRON_RUN_AS_NODE=1 && "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests\test_worker.mjs)
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Worker is plain index.js; copying it to .mjs tells Node it's a module.
const source = fileURLToPath(new URL("../worker/index.js", import.meta.url));
const copy = join(mkdtempSync(join(tmpdir(), "worker-test-")), "index.mjs");
copyFileSync(source, copy);
const worker = (await import(pathToFileURL(copy).href)).default;

const env = {
  GITHUB_TOKEN: "t", WATCHMODE_API_KEY: "wm", APP_PASSPHRASE: "pw", TMDB_API_KEY: "tm",
  GITHUB_OWNER: "o", GITHUB_REPO: "r", ALLOWED_ORIGIN: "https://patrickbernius.github.io",
};

// ---- fake servers ----
let files, calls, puts;
function reset() {
  files = {
    "movies.json": [
      { title: "Serpico", year: null },
      { title: "Scent of a Woman", year: null },
      { title: "Heat", year: "1995", tmdb_id: 949 },
    ],
    "streaming_services.json": { services: ["Netflix", "Max"] },
  };
  calls = [];
  puts = 0;
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push(url);
  const u = new URL(url);
  if (u.host === "api.github.com") {
    const path = u.pathname.split("/contents/")[1];
    if ((init.method || "GET") === "PUT") {
      puts++;
      files[path] = JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64").toString());
      return reply({});
    }
    return reply({ content: b64(JSON.stringify(files[path])), sha: "abc" });
  }
  if (u.host === "api.watchmode.com") {
    if (u.searchParams.get("regions") === null && u.pathname.includes("sources")) throw new Error("no regions");
    if (u.pathname === "/v1/title/movie-404/sources/") return reply({}, 404);
    if (u.pathname.endsWith("/sources/")) {
      return reply([{ type: "sub", name: "Netflix" }, { type: "sub", name: "Cinemax" }, { type: "rent", name: "Max" }]);
    }
    if (u.pathname === "/v1/search/") return reply({ title_results: [{ id: 77, type: "movie", year: 1973 }] });
  }
  if (u.host === "api.themoviedb.org") {
    if (u.searchParams.get("api_key") !== "tm") return reply({}, 401);
    if (u.pathname === "/3/movie/949") return reply({ poster_path: "/heat.jpg" });
    if (u.pathname === "/3/movie/404") return reply({}, 404);
    if (u.pathname === "/3/search/movie") {
      return reply({ results: [
        { id: 9475, title: "Scent of a Woman", release_date: "1992-12-23", poster_path: "/s.jpg" },
        { id: 26900, title: "Scent of a Woman", release_date: "", poster_path: null },
      ] });
    }
  }
  throw new Error("unexpected fetch " + url);
};

const call = async (method, path, body, headers = { "X-Passphrase": "pw" }) => {
  const res = await worker.fetch(new Request("https://w.dev" + path, {
    method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: res.status === 204 ? null : await res.json(), res };
};

let pass = 0, fail = 0;
function check(name, ok) { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name); }

// ---- tests ----
reset();
check("health", (await call("GET", "/api/health", null, {})).data.ok === true);
check("wrong passphrase -> 401", (await call("GET", "/api/search?q=x", null, { "X-Passphrase": "no" })).status === 401);

reset();
let r = await call("GET", "/api/search?q=scent");
check("search maps results", r.status === 200 && r.data.results[0].tmdb_id === 9475 && r.data.results[0].year === "1992"
  && r.data.results[0].thumb === "https://image.tmdb.org/t/p/w92/s.jpg");
check("search: unknown year and poster become null", r.data.results[1].year === null && r.data.results[1].thumb === null);
check("search without q -> 400", (await call("GET", "/api/search")).status === 400);

reset();
r = await call("GET", "/api/check?title=Heat&year=1995&tmdb_id=949");
const wm = calls.filter((c) => c.includes("watchmode"));
check("check with tmdb_id: one Watchmode call", wm.length === 1 && wm[0].includes("/title/movie-949/sources/"));
check("check: sub only, Max != Cinemax", JSON.stringify(r.data.availableOn) === '["Netflix"]' && r.data.matched === true);

reset();
r = await call("GET", "/api/check?title=Serpico&tmdb_id=404");
check("check: unknown tmdb_id falls back to search", r.status === 200 && r.data.matched
  && calls.filter((c) => c.includes("watchmode")).length === 3 && calls.some((c) => c.includes("/title/77/sources/")));

reset();
r = await call("GET", "/api/check?title=Serpico");
check("check without tmdb_id: search + sources", calls.filter((c) => c.includes("watchmode")).length === 2);
check("check: bad tmdb_id -> 400", (await call("GET", "/api/check?title=x&tmdb_id=1;drop")).status === 400);

reset();
r = await call("GET", "/api/poster?title=Heat&tmdb_id=949");
check("poster by tmdb_id", r.data.url === "https://image.tmdb.org/t/p/w342/heat.jpg" && !calls.some((c) => c.includes("search")));
r = await call("GET", "/api/poster?title=Scent&tmdb_id=404");
check("poster: unknown tmdb_id falls back to search", r.data.url === "https://image.tmdb.org/t/p/w342/s.jpg");
check("poster: cache header", r.res.headers.get("Cache-Control") === "private, max-age=604800");

reset();
r = await call("POST", "/api/movies", { title: "Up", year: "2009", tmdb_id: 14160 });
check("add stores tmdb_id", r.status === 200 && files["movies.json"].at(-1).tmdb_id === 14160);
r = await call("POST", "/api/movies", { title: "Big" });
check("add without tmdb_id stores null", files["movies.json"].at(-1).tmdb_id === null && files["movies.json"].at(-1).year === null);
check("duplicate still blocked", (await call("POST", "/api/movies", { title: "serpico" })).status === 409);

reset();
r = await call("PATCH", "/api/movies", { updates: [
  { title: "SERPICO", year: "1973", tmdb_id: 9040 },
  { title: "Scent of a Woman", year: "1992", tmdb_id: 9475 },
  { title: "Removed Meanwhile", year: "2000", tmdb_id: 1 },
] });
const m = files["movies.json"];
check("patch: one commit", puts === 1);
check("patch: case-insensitive, titles unchanged", m[0].title === "Serpico" && m[0].year === "1973" && m[0].tmdb_id === 9040);
check("patch: second movie + changed count", m[1].tmdb_id === 9475 && r.data.changed === 2);
check("patch: others untouched", m[2].tmdb_id === 949 && m.length === 3);
check("patch: bad id -> 400, nothing saved", (await call("PATCH", "/api/movies", { updates: [{ title: "Heat", tmdb_id: "x" }] })).status === 400 && puts === 1);
check("patch: null entry -> 400", (await call("PATCH", "/api/movies", { updates: [null] })).status === 400);
check("patch: not a list -> 400", (await call("PATCH", "/api/movies", { updates: "no" })).status === 400);

r = await call("OPTIONS", "/api/movies", null, { Origin: "https://patrickbernius.github.io" });
check("preflight allows PATCH", r.res.headers.get("Access-Control-Allow-Methods").includes("PATCH"));

reset();
r = await call("GET", "/api/search?q=x");
env.TMDB_API_KEY = "bad";
check("bad TMDB key -> clear 502", (await call("GET", "/api/search?q=x")).data.error === "TMDB rejected the API key.");
delete env.TMDB_API_KEY;
check("missing TMDB key -> clear 500", (await call("GET", "/api/search?q=x")).data.error.includes("TMDB_API_KEY"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
