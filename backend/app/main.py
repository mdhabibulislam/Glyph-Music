"""Glyph Music API. Every route is closed unless it is explicitly listed as public."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import audio, spotify
from .config import QUALITIES, Settings
from .db import Database
from .jobs import DEFAULT_MUSIC, JobError, JobManager
from .library import Library
from .security import (LoginLimiter, code_matches, code_matches_hash, hash_code, new_session_id, sign_token,
                       verify_token)
from .zipstream import stream_zip

COOKIE = "glyph_session"
PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/session",
                "/api/auth/status", "/api/auth/setup"}
CODE_KEY = "access_code_hash"
ID_RE = re.compile(r"^[0-9a-f]{32}$")


class LoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=256)


class SetupBody(BaseModel):
    code: str = Field(min_length=8, max_length=256)


class FetchBody(BaseModel):
    url: str = Field(min_length=1, max_length=400)


class CsvBody(BaseModel):
    name: str = Field(default="", max_length=200)
    csv: str = Field(min_length=1, max_length=spotify.MAX_CSV_BYTES)


class StartBody(BaseModel):
    indexes: list[int] | None = Field(default=None, max_length=5000)
    quality: int = 320


class RetryBody(BaseModel):
    quality: int = 320


class SettingsBody(BaseModel):
    default_quality: int | None = None
    max_concurrent: int | None = Field(default=None, ge=1, le=6)
    download_folder: str | None = Field(default=None, max_length=400)
    library_folders: list[str] | None = Field(default=None, max_length=10)
    auto_zip: bool | None = None
    include_artwork: bool | None = None
    include_track_numbers: bool | None = None
    auto_cleanup: bool | None = None


def error(status: int, message: str, **extra) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def _content_disposition(filename: str) -> str:
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _clean_folder(value: str, must_exist: bool) -> Path:
    value = value.strip().strip('"')
    if "\x00" in value:
        raise ValueError("Invalid folder path.")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"Use a full path such as C:\\Users\\You\\Music (got: {value}).")
    path = path.resolve()
    if must_exist and not path.is_dir():
        raise ValueError(f"Folder not found: {path}")
    return path


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    db = Database(settings.data_dir / "glyph.db")
    library = Library(db)
    jobs = JobManager(settings, db, library)
    limiter = LoginLimiter(settings.login_max_attempts, settings.login_window_seconds)
    session_ttl = settings.session_expiry_days * 86400
    setup_lock = threading.Lock()

    app = FastAPI(title="Glyph Music", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings, app.state.db, app.state.library, app.state.jobs, app.state.limiter = settings, db, library, jobs, limiter

    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.frontend_origins), allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["content-type"], max_age=600,
    )

    # ------------------------------------------------------------ helpers
    def client_ip(request: Request) -> str:
        if settings.trust_proxy:
            forwarded = request.headers.get("x-forwarded-for", "")
            if forwarded:
                return forwarded.split(",")[0].strip()[:64]
        return request.client.host if request.client else "unknown"

    def is_https(request: Request) -> bool:
        if settings.cookie_secure in ("true", "false"):
            return settings.cookie_secure == "true"
        return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"

    def current_session(request: Request) -> dict | None:
        data = verify_token(settings.session_secret, "session", request.cookies.get(COOKIE))
        if not data or not data.get("sid") or db.is_revoked(data["sid"]):
            return None
        # A session only counts for the access code it was issued under: with no code set,
        # or after reset-code.bat, every older cookie stops working.
        current = code_generation()
        if current is None or data.get("g") != current:
            return None
        return data

    def set_cookie(response: Response, request: Request, value: str, max_age: int) -> None:
        response.set_cookie(COOKIE, value, max_age=max_age, httponly=True, secure=is_https(request),
                            samesite="lax", path="/")

    def is_configured() -> bool:
        return bool(settings.access_code) or db.get_setting(CODE_KEY) is not None

    def check_code(supplied: str) -> bool:
        if settings.access_code:  # an explicit code in .env takes precedence
            return code_matches(settings.access_code, supplied)
        stored = db.get_setting(CODE_KEY)
        return bool(stored) and code_matches_hash(stored, supplied)

    def code_generation() -> str | None:
        """Identifies the current access code without revealing it."""
        if settings.access_code:
            return hashlib.sha256(f"{settings.session_secret}:{settings.access_code}".encode()).hexdigest()[:16]
        stored = db.get_setting(CODE_KEY)
        return str(stored.get("salt", ""))[:16] or None if stored else None

    def signed_in(request: Request) -> JSONResponse:
        token = sign_token(settings.session_secret, "session",
                           {"sid": new_session_id(), "g": code_generation()}, session_ttl)
        response = JSONResponse({"ok": True, "expires_in": session_ttl})
        set_cookie(response, request, token, session_ttl)
        return response

    def get_job(job_id: str):
        if not ID_RE.match(job_id):
            return None
        return jobs.get(job_id)

    def playlist_payload(job) -> dict:
        return {"playlist": job.playlist, "job": jobs.snapshot(job), "estimates": jobs.estimates(job),
                "folder": str(job.folder), "library_count": library.count()}

    # ------------------------------------------------------------ gatekeeper
    @app.middleware("http")
    async def gatekeeper(request: Request, call_next):
        path = request.url.path
        if request.method == "OPTIONS":
            return await call_next(request)
        # CSRF: state-changing requests must come from our own frontend.
        if request.method not in ("GET", "HEAD"):
            origin = request.headers.get("origin")
            if origin and origin.rstrip("/") not in settings.frontend_origins:
                return error(403, "Request origin is not allowed.")
        if path not in PUBLIC_PATHS and not path.startswith("/api/dl/"):
            if current_session(request) is None:
                return error(401, "Not signed in.")
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    # ------------------------------------------------------------ auth
    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/auth/status")
    def auth_status():
        return {"configured": is_configured()}

    @app.post("/api/auth/setup")
    def auth_setup(body: SetupBody, request: Request):
        """First run only: create the access code. Once one exists this is closed for good;
        the only way to replace it is reset-code.bat on the PC that runs the backend."""
        with setup_lock:  # two simultaneous requests can never both succeed
            if is_configured():
                return error(409, "An access code has already been set.", code="already_configured")
            if body.code != body.code.strip() or body.code == settings.session_secret:
                return error(422, "Choose a different code, without spaces at the start or end.")
            db.set_setting(CODE_KEY, hash_code(body.code))
        return signed_in(request)

    @app.post("/api/auth/login")
    async def login(body: LoginBody, request: Request):
        if not is_configured():
            return error(409, "No access code has been set yet.", code="setup_required")
        ip = client_ip(request)
        wait = limiter.retry_after(ip)
        if wait:
            return JSONResponse({"error": "Too many incorrect attempts. Try again later.", "retry_after": wait},
                                status_code=429, headers={"Retry-After": str(wait)})
        if not check_code(body.code):
            left = limiter.record_failure(ip)
            await asyncio.sleep(0.4)  # blunt brute-force attempts
            return error(401, "Incorrect access code.", attempts_left=left)
        limiter.reset(ip)
        return signed_in(request)

    @app.post("/api/auth/logout")
    def logout(request: Request):
        data = current_session(request)
        if data:
            db.revoke_session(data["sid"], data["exp"])
        response = JSONResponse({"ok": True})
        set_cookie(response, request, "", 0)
        return response

    @app.get("/api/auth/session")
    def session(request: Request):
        data = current_session(request)
        if not data:
            return JSONResponse({"authenticated": False}, status_code=401)
        return {"authenticated": True, "expires_at": data["exp"]}

    # ------------------------------------------------------------ playlists
    @app.post("/api/playlist/fetch")
    def playlist_fetch(body: FetchBody):
        try:
            playlist = spotify.fetch_playlist(body.url, settings.max_playlist_tracks, db)
        except ValueError as e:
            return error(422, str(e), code="bad_url")
        except spotify.MetadataError as e:
            return error(502, str(e), code=e.code, fallback="csv")
        return playlist_payload(jobs.create(playlist))

    @app.post("/api/playlist/import-csv")
    def playlist_import(body: CsvBody):
        try:
            playlist = spotify.import_csv(body.csv, body.name, settings.max_playlist_tracks)
        except spotify.MetadataError as e:
            return error(422, str(e), code=e.code)
        return playlist_payload(jobs.create(playlist))

    # ------------------------------------------------------------ jobs
    @app.get("/api/jobs/{job_id}")
    def job_get(job_id: str):
        job = get_job(job_id)
        return playlist_payload(job) if job else error(404, "That playlist is no longer available.")

    @app.post("/api/jobs/{job_id}/start")
    def job_start(job_id: str, body: StartBody):
        job = get_job(job_id)
        if not job:
            return error(404, "That playlist is no longer available.")
        try:
            queued = jobs.start(job, body.indexes, body.quality)
        except JobError as e:
            return error(e.status, str(e))
        return {"queued": queued, "job": jobs.snapshot(job)}

    @app.post("/api/jobs/{job_id}/retry")
    def job_retry(job_id: str, body: RetryBody):
        job = get_job(job_id)
        if not job:
            return error(404, "That playlist is no longer available.")
        try:
            queued = jobs.retry_failed(job, body.quality)
        except JobError as e:
            return error(e.status, str(e))
        return {"queued": queued, "job": jobs.snapshot(job)}

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str):
        job = get_job(job_id)
        if not job:
            return error(404, "That playlist is no longer available.")
        return {"cancelling": jobs.cancel(job), "job": jobs.snapshot(job)}

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str, request: Request):
        job = get_job(job_id)
        if not job:
            return error(404, "That playlist is no longer available.")

        async def stream():
            sent, last_beat, last_stats = 0, time.time(), 0.0
            while True:
                if await request.is_disconnected():
                    return
                now = time.time()
                running = job.outstanding > 0
                if job.version != sent or (running and now - last_stats >= 1.0):
                    snap = jobs.snapshot(job, since=sent)
                    sent, last_stats, last_beat = snap["version"], now, now
                    yield f"data: {json.dumps(snap, separators=(',', ':'))}\n\n"
                elif now - last_beat > 15:
                    last_beat = now
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.2)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

    # ------------------------------------------------------------ files
    @app.get("/api/jobs/{job_id}/tracks/{index}/file")
    def track_file(job_id: str, index: int):
        job = get_job(job_id)
        path = jobs.completed_file(job, index) if job else None
        if not path:
            return error(404, "That song hasn't been downloaded.")
        return FileResponse(path, media_type="audio/mpeg", headers={
            "Content-Disposition": _content_disposition(path.name)})

    @app.get("/api/jobs/{job_id}/tracks/{index}/art")
    def track_art(job_id: str, index: int):
        job = get_job(job_id)
        if not job or not 0 <= index < len(job.tracks):
            return error(404, "Not found.")
        ts = job.tracks[index]
        source = Path(ts.match["path"]) if ts.match else jobs.completed_file(job, index)
        art = audio.extract_embedded_art(source) if source and source.is_file() else None
        if not art or art[1] not in ("image/jpeg", "image/png"):
            return error(404, "No artwork.")
        return Response(art[0], media_type=art[1], headers={"Cache-Control": "private, max-age=86400"})

    def zip_response(job):
        try:
            entries = jobs.zip_entries(job)
        except JobError as e:
            return error(e.status, str(e))
        return StreamingResponse(stream_zip(entries), media_type="application/zip", headers={
            "Content-Disposition": _content_disposition(jobs.zip_name(job))})

    @app.get("/api/jobs/{job_id}/zip")
    def job_zip(job_id: str):
        job = get_job(job_id)
        return zip_response(job) if job else error(404, "That playlist is no longer available.")

    @app.get("/api/jobs/{job_id}/zip-link")
    def job_zip_link(job_id: str):
        """A download URL. With PUBLIC_BACKEND_URL set (Vercel mode) this is a short-lived signed
        link straight to the backend, so large archives don't pass through Vercel."""
        job = get_job(job_id)
        if not job:
            return error(404, "That playlist is no longer available.")
        if settings.public_backend_url:
            token = sign_token(settings.session_secret, "download", {"job": job.id}, 300)
            return {"url": f"{settings.public_backend_url}/api/dl/{token}", "name": jobs.zip_name(job)}
        return {"url": f"/api/jobs/{job.id}/zip", "name": jobs.zip_name(job)}

    @app.get("/api/dl/{token}")
    def signed_download(token: str):
        data = verify_token(settings.session_secret, "download", token)
        job = get_job(str(data.get("job", ""))) if data else None
        if not job:
            return error(403, "This download link is invalid or has expired.")
        return zip_response(job)

    # ------------------------------------------------------------ history
    @app.get("/api/history")
    def history_list():
        rows = db.query("SELECT id,name,cover_url,source,started_at,updated_at,total,completed,failed,bytes,quality,folder"
                        " FROM history ORDER BY updated_at DESC LIMIT 500")
        return {"items": [dict(r) for r in rows]}

    @app.delete("/api/history/{job_id}")
    def history_delete(job_id: str, files: bool = False):
        if not ID_RE.match(job_id):
            return error(404, "Not found.")
        try:
            jobs.delete(job_id, files)
        except JobError as e:
            return error(e.status, str(e))
        return {"ok": True}

    # ------------------------------------------------------------ settings + library
    def settings_payload() -> dict:
        music = jobs.music()
        return {**music, "library_folders": library.folders(), "download_folder_effective": str(jobs.download_root()),
                "library": {"tracks": library.count(), **library.scan}, "ffmpeg": bool(jobs.ffmpeg),
                "qualities": list(QUALITIES),
                "limits": {"max_playlist_tracks": settings.max_playlist_tracks, "max_job_gb": settings.max_job_gb,
                           "max_source_file_mb": settings.max_source_file_mb}}

    @app.get("/api/settings")
    def settings_get():
        return settings_payload()

    @app.put("/api/settings")
    def settings_put(body: SettingsBody):
        music = jobs.music()
        changes = body.model_dump(exclude_none=True)
        try:
            if "default_quality" in changes and changes["default_quality"] not in QUALITIES:
                raise ValueError("Unsupported audio quality.")
            if "download_folder" in changes and changes["download_folder"].strip():
                folder = _clean_folder(changes["download_folder"], must_exist=False)
                folder.mkdir(parents=True, exist_ok=True)
                changes["download_folder"] = str(folder)
            if "library_folders" in changes:
                folders = [str(_clean_folder(f, must_exist=True)) for f in changes.pop("library_folders") if f.strip()]
                db.set_setting("library_folders", list(dict.fromkeys(folders)))
                library.start_scan()
        except (ValueError, OSError) as e:
            return error(422, str(e))
        db.set_setting("music", {k: changes.get(k, music[k]) for k in DEFAULT_MUSIC})
        return settings_payload()

    @app.post("/api/library/scan")
    def library_scan():
        return {"started": library.start_scan(), "library": {"tracks": library.count(), **library.scan}}

    return app
