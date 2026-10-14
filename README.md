# Drive to one ZIP

Downloads Google Drive files and folders (recursively) and packs them into **one** ZIP that keeps the folder structure.

## How it works
1. **Scan**: parses and validates links, walks folders via the Drive API v3 (paginated, shortcuts resolved, loop-safe).
2. **Download**: each file goes to a temp file on disk (never held in RAM), with retry/backoff and `Range` resume if the stream drops mid-file.
3. **Zip**: each finished file is appended to a streaming ZIP on disk (`archiver`, ZIP64 enabled for archives over 3.5 GB), then the temp file is deleted. Peak extra disk use is about one file.
4. **Serve**: the finished ZIP has a known `Content-Length`, `Accept-Ranges`, `ETag`, and `206` support, so FDM and browsers can pause and resume.
5. **Clean up**: archives are deleted after `RETENTION_MINUTES`, on cancel or failure, and on startup/shutdown (optional zero-overwrite with `SECURE_WIPE=true`).

Google-native files are exported (Docs → .docx, Sheets → .xlsx, Slides → .pptx, Drawings → .pdf). Forms, Sites and Maps can't be exported and are reported.

## Setup
1. Node 20+ and enough free disk for the archive plus the largest single file (the server checks before downloading).
2. In Google Cloud Console: enable **Google Drive API**.
   - **API key** (restrict it to the Drive API) → `GOOGLE_API_KEY`, for "anyone with the link" files.
   - **OAuth client, type Web application**, redirect URI `BASE_URL/auth/callback` → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Scope used: `drive.readonly`. (This scope is "restricted"; for personal or test use keep the app in Testing mode with yourself as a test user. Public use requires Google verification.)
3. `cp .env.example .env`, fill it in, then:
```
npm install
node --env-file=.env server.js
```

## Download managers (FDM)
Browsers can't directly hand a download to FDM. Use either FDM's browser extension (it captures the **Download ZIP** click) or **Copy link for download manager** → FDM *Add URL*. The link is an unguessable capability URL; anyone holding it can download until it expires, so don't post it publicly.

## Deployment notes
- Behind nginx: `proxy_buffering off;` (progress stream), `proxy_request_buffering off;`, and long `proxy_read_timeout`. Serve over HTTPS and set `TRUST_PROXY=1`.
- Sessions use the in-memory store: fine for one instance; use a persistent store (Redis) for multiple instances or restarts.
- Jobs are in memory too; a restart clears jobs and wipes `TEMP_DIR`.

## Limits to know about
- Public files can hit Google's per-file download quota (`downloadQuotaExceeded`, ~24h reset); those files are reported, not retried forever.
- Native-file export is capped by Google at ~10 MB per file.
- Files Google flags as malware/abusive are refused by the API and reported.
- Downloads run one file at a time for a simple, bounded-disk design. Parallel prefetch is the main future speed-up.
- ZIP stores each file as-is or lightly compressed (level 1; already-compressed types are stored), so archive size ≈ total size.
- Windows' built-in extractor is poor with ZIP64; use 7-Zip/Explorer alternatives for archives over 4 GB.

## Desktop app (one-click)
`main.js` wraps the server in Electron: it starts the server on a random local port, opens a window, saves the ZIP through a normal Save dialog, and deletes temp files on quit. Files go straight to the user's own computer, so there is no hosting cost and no upload bandwidth.

Build installers automatically with GitHub Actions (`.github/workflows/build.yml`): push the project to a GitHub repo, then create a release with a tag such as `v1.0.0`. The workflow builds Windows (.exe), macOS (.dmg) and Linux (.AppImage) and attaches them to the release. Optionally add a repository secret `DEFAULT_API_KEY` to bundle a Google API key so users need no setup (the key can be extracted from the app, so restrict it to the Drive API).

Local build: `npm install && npm run dist`, or try it with `npm run app`.
