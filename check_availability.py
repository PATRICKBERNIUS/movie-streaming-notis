"""
Weekly streaming-availability checker.

Reads movies.json (your watchlist), checks each title against Watchmode's
API, and sends a phone push notification via ntfy.sh listing any titles
currently available on the streaming services you subscribe to.

Required environment variables (set as GitHub Actions secrets — these are
genuine credentials, unlike your service list, which lives in a plain
repo file instead so it stays editable from the dashboard):
  WATCHMODE_API_KEY   - your free key from https://api.watchmode.com/
  NTFY_TOPIC          - a unique, hard-to-guess topic name, e.g. "jsmith-movie-alerts-8f2k"

Your subscribed streaming services are read from streaming_services.json
in this repo (not a secret) — the same file the dashboard's "Settings"
checkboxes write to when GitHub sync is connected.

Optional:
  ONLY_NEW            - "true" to only alert on titles not flagged last run
                        (uses seen_state.json, persisted via git commit in the workflow)
"""

import json
import os
import sys
import time
import requests

WATCHMODE_API_KEY = os.environ.get("WATCHMODE_API_KEY")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC")
ONLY_NEW = os.environ.get("ONLY_NEW", "false").lower() == "true"

MOVIES_FILE = "movies.json"
SERVICES_FILE = "streaming_services.json"
STATE_FILE = "seen_state.json"


def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def search_title(title, year=None):
    resp = requests.get(
        "https://api.watchmode.com/v1/search/",
        params={
            "apiKey": WATCHMODE_API_KEY,
            "search_field": "name",
            "search_value": title,
        },
        timeout=20,
    )
    resp.raise_for_status()
    results = [r for r in resp.json().get("title_results", []) if r.get("type") == "movie"]
    if not results:
        return None
    if year:
        for r in results:
            if str(r.get("year")) == str(year):
                return r
    return results[0]


def get_sources(watchmode_id):
    resp = requests.get(
        f"https://api.watchmode.com/v1/title/{watchmode_id}/sources/",
        params={"apiKey": WATCHMODE_API_KEY},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def matching_services(sources, my_services):
    matches = set()
    for s in sources:
        if s.get("type") != "sub":
            continue
        name = s.get("name", "")
        for my_service in my_services:
            if my_service.lower().replace("+", "") in name.lower() or name.lower() in my_service.lower():
                matches.add(my_service)
    return matches


def send_notification(available_movies):
    if not NTFY_TOPIC:
        print("No NTFY_TOPIC set, skipping notification. Available movies:", available_movies)
        return
    lines = [f"{m['title']} ({m.get('year','?')}) — {', '.join(m['services'])}" for m in available_movies]
    body = "\n".join(lines)
    title = f"{len(available_movies)} movie(s) on your list are streaming"
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=body.encode("utf-8"),
        headers={
            "Title": title,
            "Priority": "default",
            "Tags": "clapper",
        },
        timeout=20,
    )
    print(f"Notification sent to ntfy topic '{NTFY_TOPIC}'.")


def main():
    if not WATCHMODE_API_KEY:
        print("ERROR: WATCHMODE_API_KEY is not set.", file=sys.stderr)
        sys.exit(1)

    services_config = load_json(SERVICES_FILE, {"services": []})
    my_services = services_config.get("services", [])
    if not my_services:
        print(
            f"ERROR: No services listed in {SERVICES_FILE}. "
            "Check at least one service in the dashboard's Settings with GitHub sync connected.",
            file=sys.stderr,
        )
        sys.exit(1)

    movies = load_json(MOVIES_FILE, [])
    if not movies:
        print("movies.json is empty — nothing to check.")
        return

    seen_state = load_json(STATE_FILE, {})
    available_now = []

    for movie in movies:
        title = movie["title"]
        year = movie.get("year")
        key = f"{title}|{year}"

        try:
            match = search_title(title, year)
            if not match:
                print(f"No match found for: {title}")
                continue
            sources = get_sources(match["id"])
            services = matching_services(sources, my_services)
        except requests.RequestException as e:
            print(f"Lookup failed for {title}: {e}")
            continue

        if services:
            already_notified = set(seen_state.get(key, []))
            new_services = services - already_notified if ONLY_NEW else services
            if new_services:
                available_now.append({"title": title, "year": year, "services": sorted(new_services)})
            seen_state[key] = sorted(services)
        else:
            seen_state[key] = []

        time.sleep(0.5)  # be polite to the API

    save_json(STATE_FILE, seen_state)

    if available_now:
        send_notification(available_now)
    else:
        print("Nothing new available this week.")


if __name__ == "__main__":
    main()
