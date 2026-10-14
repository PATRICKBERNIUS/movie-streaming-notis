# Reel Ledger

A personal "want to watch" list that tells me which movies are streaming on
the services I subscribe to.

- **Weekly alert:** a GitHub Actions job (`.github/workflows/weekly-check.yml`)
  runs `check_availability.py` every Friday and sends a phone notification.
- **App:** a phone-friendly web app (coming in later stages) for editing the list.
- **Data:** `movies.json` and `streaming_services.json` live in this repo. The
  repo *is* the database.

## Secrets (repo Settings -> Secrets and variables -> Actions)

- `WATCHMODE_API_KEY`
- `NTFY_TOPIC`

v1 (Streamlit version): see the `Movie-Streaming-Dashboard-and-Notifications` repo.
