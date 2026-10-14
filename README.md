# Movie Streaming Update

> **Note:** This project was made mostly with AI. I designed the features and
> made the decisions; most of the code was written by Claude (Anthropic's AI
> assistant), working in stages with me reviewing, testing, and asking why at
> each step.

A personal "want to watch" list that tells me which movies on it are streaming
on the services I subscribe to. It's a phone app I can install on my home
screen, plus a weekly push notification every Friday.

**App:** https://patrickbernius.github.io/movie-streaming-notis/ (passphrase required)

## What it does

- **Poster grid** of my watchlist, two columns, built for a phone.
- **Add movies** with suggestions as I type. Picking one saves the exact film
  and year, so a remake or an older film with the same title can't be mixed up.
- **Match years:** a review screen that finds the right film for movies added
  without one. I confirm, correct, or skip each, then save them all at once.
- **Check availability** sorts the list into *Available*, *Not on your
  services*, and *Not checked yet*, showing which of my services has each movie.
- **My services** are editable in the app.
- **Friday notification:** a weekly digest of what's streaming. Tapping it
  opens the app.

## How it works

```
phone app --passphrase--> Cloudflare Worker --token--> GitHub repo (movies.json, streaming_services.json)
                                            --key----> Watchmode (where is it streaming?)
                                            --key----> TMDB (posters, titles, years)
GitHub Actions (every Friday) -> check_availability.py -> Watchmode -> ntfy -> phone
```

- **The repo is the database.** The watchlist and service list are JSON files
  in this repo. The app edits them through GitHub's API, so every change is a
  commit and the history is free.
- **The Worker holds every secret.** The app is a static page, and anything in
  a static page can be read by whoever opens it. So the page only knows a
  passphrase, and the Worker, a small server on Cloudflare's free tier,
  holds the GitHub token and API keys and does the calls for it.
- **One lookup per movie.** Each movie stores its TMDB ID once it's matched.
  Watchmode accepts TMDB IDs directly, so a check needs one Watchmode call
  per movie instead of a search plus a lookup.

## Design decisions

- **No frameworks, no build step.** The app is plain HTML, CSS, and JavaScript,
  and the Worker is a single file. Nothing to install, which matters because I
  work on a laptop that restricts installs.
- **Availability is never cached.** Streaming catalogs change often, so every
  check is live.
- **Service matching is strict on purpose.** "Peacock Premium" counts as
  Peacock, but "Cinemax" does not count as Max. The app and the Friday job
  share the same rule.
- **Only subscription streams count** (not rent or buy), US region.

## Folder layout

```
docs/                                the phone app, served by GitHub Pages
  index.html, app.js, style.css
  manifest.webmanifest, icons/       makes it installable on a home screen
worker/index.js                      the API (Cloudflare Worker)
worker/README.md                     Worker setup guide
check_availability.py                the Friday job
.github/workflows/weekly-check.yml   when the Friday job runs (Fridays 15:00 UTC)
movies.json                          the watchlist
streaming_services.json              the services I subscribe to
seen_state.json                      what the Friday job last reported
tests/                               Worker and Friday job tests (fake APIs, no keys needed)
```

## Setup

Everything is set up in the browser; no secrets live in this repo.

1. **Worker:** follow `worker/README.md` (Cloudflare dashboard). It needs
   `GITHUB_TOKEN`, `WATCHMODE_API_KEY`, `APP_PASSPHRASE`, and `TMDB_API_KEY`.
2. **App:** repo Settings → Pages → deploy from branch `main`, folder `/docs`.
   Add the Pages address to the Worker's `ALLOWED_ORIGIN`.
3. **Friday job:** repo Settings → Secrets and variables → Actions, add
   `WATCHMODE_API_KEY` and `NTFY_TOPIC`. Subscribe to that topic in the ntfy app.
4. **Install on iPhone:** open the app in Safari → Share → Add to Home Screen.

## Testing

There's no test framework. The Worker is tested by importing it in Node and
replacing `fetch` with fake GitHub, Watchmode, and TMDB servers, so every
route and error path can be checked without real keys or network calls. The
Friday job is tested the same way in Python. From the repo root:

```
node tests/test_worker.mjs
python tests/test_check_availability.py
```

## History

v1 was a Streamlit dashboard; it lives on in the
`Movie-Streaming-Dashboard-and-Notifications` repo.
