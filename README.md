# Movie Streaming Update

A personal "want to watch" list that tells me which movies are streaming on
the services I subscribe to.

- **Weekly alert:** a GitHub Actions job (`.github/workflows/weekly-check.yml`)
  runs `check_availability.py` every Friday and sends a phone notification.
- **API:** a Cloudflare Worker (`worker/`) that holds the secrets and lets the
  app read and edit the list. See `worker/README.md` to set it up.
- **App:** a phone-friendly web app (coming in later stages) for editing the list.
- **Data:** `movies.json` and `streaming_services.json` live in this repo. The
  repo *is* the database.

## How the pieces fit

```
phone app --passphrase--> Worker --token--> GitHub repo (movies.json, streaming_services.json)
                                  --key-----> Watchmode
GitHub Actions (every Friday) --reads the same files--> Watchmode --> ntfy --> phone
```

## Folder layout

```
.github/workflows/weekly-check.yml   when to run the Friday job
check_availability.py                the Friday job itself
movies.json                          the watchlist
streaming_services.json              the services I subscribe to
seen_state.json                      what the Friday job last reported
worker/index.js                      the API
worker/README.md                     Worker setup guide
```

## Secrets

GitHub repo Settings -> Secrets and variables -> Actions (for the Friday job):

- `WATCHMODE_API_KEY`
- `NTFY_TOPIC`

The Worker has its own separate secrets, listed in `worker/README.md`.

v1 (Streamlit version): see the `Movie-Streaming-Dashboard-and-Notifications` repo.
