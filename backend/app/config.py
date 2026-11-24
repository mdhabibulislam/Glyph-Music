"""Environment-driven configuration. Secrets never have defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]

QUALITIES = (128, 192, 256, 320)


class ConfigError(RuntimeError):
    pass


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # Optional. Normally empty: the code is created once on the website (first-run setup).
    access_code: str = ""
    session_secret: str = ""
    session_expiry_days: int = 7
    data_dir: Path = ROOT / "backend" / "data"
    frontend_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    public_backend_url: str = ""
    cookie_secure: str = "auto"  # auto | true | false
    trust_proxy: bool = False
    max_playlist_tracks: int = 1000
    max_source_file_mb: int = 400
    max_job_gb: float = 20.0
    login_max_attempts: int = 5
    login_window_seconds: int = 900
    ffmpeg_path: str = ""
    host: str = "127.0.0.1"
    port: int = 8787

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv(ROOT / ".env")
        env = os.environ
        origins = tuple(
            o.strip().rstrip("/")
            for o in env.get("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
            if o.strip()
        )
        data_dir = Path(env.get("DATA_DIR") or (ROOT / "backend" / "data")).expanduser().resolve()
        return cls(
            access_code=env.get("ADMIN_ACCESS_CODE", ""),
            session_secret=env.get("SESSION_SECRET", ""),
            session_expiry_days=int(env.get("SESSION_EXPIRY_DAYS") or 7),
            data_dir=data_dir,
            frontend_origins=origins,
            public_backend_url=(env.get("PUBLIC_BACKEND_URL") or "").strip().rstrip("/"),
            cookie_secure=(env.get("COOKIE_SECURE") or "auto").strip().lower(),
            trust_proxy=_bool(env.get("TRUST_PROXY")),
            max_playlist_tracks=int(env.get("MAX_PLAYLIST_TRACKS") or 1000),
            max_source_file_mb=int(env.get("MAX_SOURCE_FILE_MB") or 400),
            max_job_gb=float(env.get("MAX_JOB_GB") or 20),
            login_max_attempts=int(env.get("LOGIN_MAX_ATTEMPTS") or 5),
            login_window_seconds=int(env.get("LOGIN_WINDOW_SECONDS") or 900),
            ffmpeg_path=(env.get("FFMPEG_PATH") or "").strip(),
            host=env.get("BACKEND_HOST") or "127.0.0.1",
            port=int(env.get("BACKEND_PORT") or 8787),
        )

    def validate(self) -> None:
        """Refuse to run with missing or weak secrets."""
        if self.access_code and len(self.access_code) < 8:
            raise ConfigError("ADMIN_ACCESS_CODE, when set, needs at least 8 characters. "
                              "Leave it empty to create the code on the website.")
        if len(self.session_secret) < 32:
            raise ConfigError("SESSION_SECRET must be set (at least 32 random characters). Run setup.bat or edit .env.")
        if self.access_code and self.access_code == self.session_secret:
            raise ConfigError("ADMIN_ACCESS_CODE and SESSION_SECRET must be different values.")
        if not 1 <= self.session_expiry_days <= 90:
            raise ConfigError("SESSION_EXPIRY_DAYS must be between 1 and 90.")
        if self.cookie_secure not in ("auto", "true", "false"):
            raise ConfigError("COOKIE_SECURE must be auto, true or false.")
