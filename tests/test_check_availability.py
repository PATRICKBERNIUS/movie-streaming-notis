"""
Run check_availability.main() against fake Watchmode/ntfy in a temp folder.

Run from the repo root:  python tests/test_check_availability.py
"""
import importlib.util, json, os, sys, tempfile

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
work = tempfile.mkdtemp()
os.chdir(work)
json.dump([
    {"title": "Heat", "year": "1995", "tmdb_id": 949},
    {"title": "Odd", "year": None, "tmdb_id": 404},
    {"title": "Serpico", "year": None},
], open("movies.json", "w"))
json.dump({"services": ["Netflix", "Max"]}, open("streaming_services.json", "w"))
os.environ.update(WATCHMODE_API_KEY="wm", NTFY_TOPIC="topic")

try:
    import requests
except ModuleNotFoundError:
    # No install needed: a stand-in with just what check_availability.py uses.
    import types
    requests = types.ModuleType("requests")
    class RequestException(Exception):
        def __init__(self, *a, response=None):
            super().__init__(*a)
            self.response = response
    class HTTPError(RequestException):
        pass
    requests.RequestException, requests.HTTPError = RequestException, HTTPError
    sys.modules["requests"] = requests

class Resp:
    def __init__(self, data, status=200):
        self.data, self.status_code = data, status
    def json(self):
        return self.data
    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)

calls, posts = [], []
def fake_get(url, params=None, timeout=None):
    calls.append((url, dict(params or {})))
    if "/sources/" in url:
        assert params.get("regions") == "US", "regions=US missing"
        if "movie-404" in url:
            return Resp({}, 404)
        return Resp([{"type": "sub", "name": "Netflix"}, {"type": "sub", "name": "Cinemax"}])
    if url.endswith("/search/"):
        return Resp({"title_results": [{"id": 77, "type": "movie", "year": 1973}]})
    raise AssertionError(url)
def fake_post(url, data=None, headers=None, timeout=None):
    posts.append(headers)
    return Resp({})
requests.get, requests.post = fake_get, fake_post

spec = importlib.util.spec_from_file_location("ca", os.path.join(repo, "check_availability.py"))
ca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ca)
ca.time.sleep = lambda s: None
ca.main()

urls = [u for u, _ in calls]
results = {
    "Heat uses TMDB id, no search": urls[0].endswith("/title/movie-949/sources/") and urls[1].endswith("/title/movie-404/sources/"),
    "unknown TMDB id falls back to search": urls[2].endswith("/search/") and urls[3].endswith("/title/77/sources/"),
    "no-id movie searches": urls[4].endswith("/search/") and urls[5].endswith("/title/77/sources/"),
    "total Watchmode calls = 6": len(urls) == 6,
    "notification has Click to the app": posts and posts[0].get("Click", "").startswith("https://patrickbernius.github.io/"),
    "Max does not match Cinemax": json.load(open("seen_state.json"))["Heat|1995"] == ["Netflix"],
}
for name, ok in results.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if all(results.values()) else 1)
