# Movie Streaming Update API (Cloudflare Worker)

`index.js` is the whole backend: one file, no dependencies, no build step.
It holds the secrets and does the talking to GitHub and Watchmode so the phone
app never sees a key.

## Setup (browser only, ~20 minutes, nothing to install)

### 1. Make a GitHub token for the Worker

GitHub -> profile picture -> Settings -> Developer settings ->
Personal access tokens -> Fine-grained tokens -> Generate new token.

- Repository access: **Only select repositories** -> pick this repo
- Permissions -> Repository permissions -> **Contents: Read and write**
- Nothing else. Copy the token now; GitHub shows it once.

### 2. Create the Worker

1. Sign up free at https://dash.cloudflare.com (no card needed).
2. Left sidebar: **Workers & Pages** -> **Create** -> **Create Worker**.
3. Name it `movie-streaming-update-api` -> **Deploy** (it deploys a hello-world stub).
4. Click **Edit code**. Delete everything in the editor, paste in all of
   `index.js`, and click **Deploy**.

### 3. Add the configuration

Worker -> **Settings** -> **Variables and Secrets** -> Add. Use the right *type*:

| Name | Type | Value |
|------|------|-------|
| `GITHUB_TOKEN` | **Secret** | token from step 1 |
| `WATCHMODE_API_KEY` | **Secret** | your Watchmode key |
| `APP_PASSPHRASE` | **Secret** | a long phrase you invent (this is your app login) |
| `GITHUB_OWNER` | Text | your GitHub username |
| `GITHUB_REPO` | Text | this repo's name |
| `ALLOWED_ORIGIN` | Text | `https://YOURUSERNAME.github.io,http://localhost:8000` |

Notes:
- `ALLOWED_ORIGIN` is the address your app will be served from (Stage 4),
  **lowercase, no path, no trailing slash**. Comma-separate several.
- "Secret" values are hidden after saving. Text values stay readable.
- Click **Deploy** after adding variables.

### 4. Test it

Your Worker's address is shown on its overview page, like
`https://movie-streaming-update-api.YOURNAME.workers.dev`. In a Windows terminal use
`curl.exe` (plain `curl` in PowerShell is something else):

```
curl.exe https://movie-streaming-update-api.YOURNAME.workers.dev/api/health
```
Expect `{"ok":true}`. Then, with your passphrase:

```
curl.exe -H "X-Passphrase: YOUR PASSPHRASE" https://movie-streaming-update-api.YOURNAME.workers.dev/api/data
```
Expect your movies and services. Try again with a wrong passphrase and
expect `{"error":"Wrong or missing passphrase."}`.

## Troubleshooting

| You see | Meaning |
|---------|---------|
| `Wrong or missing passphrase` | header typo, or `APP_PASSPHRASE` not saved/deployed |
| `GitHub rejected the token` | wrong token, wrong repo selected, or Contents isn't Read and write |
| `GitHub returned 404` | `GITHUB_OWNER` / `GITHUB_REPO` misspelled |
| `Watchmode rejected the API key` | `WATCHMODE_API_KEY` wrong |
| `Server is missing the APP_PASSPHRASE secret` | add it, then Deploy |

## Changing the code later

Edit `index.js` in the repo (the repo copy is the source of truth), then paste
it into the Cloudflare editor and Deploy.
