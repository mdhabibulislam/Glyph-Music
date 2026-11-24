# Glyph Music

Your private music sanctuary. Paste a Spotify playlist, album or song link, and Glyph Music
reads the track list, finds each song in **your own music library**, converts it to tagged MP3,
and hands you the whole playlist as a ZIP. Single user, access-code login, runs on your PC.

## What it does, and what it doesn't

| Step | How |
| --- | --- |
| Playlist metadata | Spotify's public embed pages. No API key, no account, no fees. |
| Audio | Files in the music folders you add in **Settings**. Matched by title, artist and length (RapidFuzz). |
| Conversion | FFmpeg to MP3 at 128 / 192 / 256 / 320 kbps, tagged with Mutagen (title, artist, album, artwork, track number). |
| Delivery | Individual MP3s, or a streamed ZIP with `Playlist.m3u`, `Playlist.csv` and `Download-report.txt`. |

**It does not download audio from Spotify, YouTube or any other streaming service.** Spotify's
audio is DRM-protected, and ripping from streaming sites breaks their terms and, for most music,
copyright. The audio source is music you already have on disk. Songs that aren't in your library
are shown as *Unavailable* and listed in the report, so you know exactly what's missing.

Honest quality: a file is never encoded above its source. A 128 kbps MP3 stays a 128 kbps MP3
(copied untouched); lossless files (FLAC, WAV, ALAC) are encoded at the quality you choose.

### When Spotify can't be read

- **Playlists longer than 100 songs:** the public page only lists the first 100. The app tells you.
- **Private playlists, or networks that block Spotify:** the fetch fails with an explanation.

In both cases use **Import CSV**: export the playlist (for example with Exportify) and drop the
file in. Any CSV with a title column and an artist column works.

## Quick start (Windows, local mode)

Requirements: [Node.js 20+](https://nodejs.org) and [Python 3.10+](https://www.python.org/downloads/)
(tick "Add python.exe to PATH"). FFmpeg is bundled; nothing else to install.

1. Put the project in a short path such as `C:\GlyphMusic`.
2. Double-click **`setup.bat`**. It installs everything and builds the site.
3. Double-click **`start.bat`**. The backend and website start and your browser opens `http://localhost:3000`.
4. The first time, the site asks you to **create your access code**. After that it only asks you to unlock.
5. Open **Settings**, add your music folder, then paste a playlist link on **Home**.

`start-backend.bat` starts only the Python backend (used for Vercel mode). `reset-code.bat`
clears the access code so it can be created again.

### Your access code

You create the code on the website the first time you open it. From then on the website can
never set or change it again, for anyone, signed in or not. Only a salted hash is kept, in the
local database on your PC; the code itself is not stored anywhere.

- **Set it straight away.** Until a code exists, whoever opens the site first is the one who
  sets it. Open the site and create your code as soon as it is running or deployed.
- **Forgot it, or want a new one?** Close the backend, run `reset-code.bat` on your PC, start
  the backend and open the site: it asks you to create a code again.
- **Prefer a fixed code?** Put it in `ADMIN_ACCESS_CODE` in `.env`. That switches the website's
  first-run setup off entirely.

## Architecture

```
Browser ──► Next.js (localhost:3000 or Vercel) ──/api proxy──► FastAPI on your PC (127.0.0.1:8787)
            pages + middleware gate                            auth, metadata, FFmpeg, ZIP, SQLite
```

- The browser only talks to the website's own origin. `/api/*` is proxied to the backend, so the
  session cookie is first-party, `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- `middleware.ts` checks every page request against the backend before rendering anything.
- The backend is closed by default: a single gatekeeper rejects any request without a valid
  session, except login, logout, the session check, health, and signed download links.
- Progress is real: Server-Sent Events carry the workers' own byte and FFmpeg counters.

```
app/            Next.js pages (login, home, downloads, history, settings)
components/     Glyph background, glass UI, composer, playlist panel, tweaks
lib/            API client, download state, tweaks, procedural animals
backend/app/    FastAPI app: security, spotify, library, audio, jobs, zipstream
backend/tests/  Authentication and backend tests
```

## Security

- The access code is created once on the website, stored only as a salted scrypt hash, and checked
  on the server in constant time. Setup closes permanently once a code exists.
- Signed session cookies (HMAC-SHA256), seven-day expiry, server-side revocation on logout.
- Login rate limiting: 5 wrong attempts per 15 minutes per client, plus a global cap.
- CSRF: cross-origin state-changing requests are refused; CORS only allows `FRONTEND_ORIGINS`.
- SSRF: only a validated Spotify ID is ever used to build outbound requests; artwork is fetched
  only from Spotify's image hosts; redirects are never followed.
- Path traversal: filenames are sanitised and every output path is checked to stay in its folder.
- FFmpeg is run with an argument list (no shell), absolute paths, and no stdin.
- Limits on playlist length, source file size and job size; temp files are cleaned up.
- The app refuses to start if the session secret is missing or weak.

Run the tests:

```powershell
npm test
```

## Deploying: private GitHub repo + Vercel frontend + your PC as backend

Vercel can't run long audio jobs or hold large files, so only the website lives there. Your PC
runs the backend and is reached through a free HTTPS tunnel. Cost: zero.

### 1. Push to a private GitHub repository

```powershell
git init -b main
```
```powershell
git add .
```
```powershell
git commit -m "Glyph Music"
```
```powershell
gh repo create glyph-music --private --source . --push
```

(`gh` is the [GitHub CLI](https://cli.github.com). `.gitignore` already excludes `.env`, the
database, downloads, music files and ZIPs.)

### 2. Expose the backend over HTTPS

Tailscale Funnel gives a stable address for free:

```powershell
winget install --id Tailscale.Tailscale -e
```
```powershell
tailscale funnel --bg 8787
```

It prints an address like `https://your-pc.your-tailnet.ts.net`. (Cloudflare Tunnel also works:
`cloudflared tunnel --url http://127.0.0.1:8787`, but its free quick-tunnel address changes each run.)

### 3. Point the backend at your site

Edit `.env` on your PC, then restart `start-backend.bat`:

```
FRONTEND_ORIGINS=https://YOUR-SITE.vercel.app,http://localhost:3000
PUBLIC_BACKEND_URL=https://your-pc.your-tailnet.ts.net
TRUST_PROXY=true
COOKIE_SECURE=true
```

### 4. Deploy the frontend

```powershell
npm install -g vercel
```
```powershell
vercel link
```
```powershell
vercel env add BACKEND_URL production
```
(paste your tunnel address when asked)
```powershell
vercel --prod
```

Only `BACKEND_URL` goes to Vercel. The session secret and the access code's hash stay on your PC.
After the first deploy, put the real `https://...vercel.app` address into `FRONTEND_ORIGINS`,
restart the backend, then **open the site and create your access code right away**.

In Vercel mode, large ZIPs are downloaded straight from your PC through a signed link that
expires after five minutes, so they never pass through Vercel. Your PC must be on, with
`start-backend.bat` and the tunnel running, for the site to work.

## Configuration

All settings are in `.env` (see `.env.example` for the full list).

| Variable | Purpose |
| --- | --- |
| `ADMIN_ACCESS_CODE` | Leave empty to create the code on the website. Optional fixed code (8+ characters). |
| `SESSION_SECRET` | 32+ random characters; signs cookies and download links. |
| `SESSION_EXPIRY_DAYS` | How long a login lasts. Default 7. |
| `BACKEND_URL` | Where the website finds the backend. |
| `FRONTEND_ORIGINS` | Origins allowed to call the backend. |
| `PUBLIC_BACKEND_URL` | Tunnel address, for direct ZIP downloads in Vercel mode. |
| `MAX_PLAYLIST_TRACKS`, `MAX_SOURCE_FILE_MB`, `MAX_JOB_GB` | Processing limits. |
| `DATA_DIR`, `FFMPEG_PATH` | Optional overrides. |

Music preferences (quality, simultaneous downloads, download folder, automatic ZIP, artwork,
track numbers, temp cleanup) are in **Settings** and the **Tweaks** panel, stored in SQLite.
Visual tweaks are stored in your browser.

## Troubleshooting

- **"The backend on your PC isn't reachable"**: start `start-backend.bat` (and the tunnel in Vercel mode).
- **Everything is Unavailable**: add your music folder in Settings and wait for the scan to finish.
- **A song isn't matched**: check the file's title and artist tags, or name it `Artist - Title.ext`.
- **setup.bat can't create the Python environment**: move the project to a shorter path.
