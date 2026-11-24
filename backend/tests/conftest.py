"""Shared fixtures. Test audio is synthesised with FFmpeg (sine tones), so it is ours to use."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import audio  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

CODE = "test-access-code-123"
SECRET = "s" * 48
ORIGIN = "http://localhost:3000"


def make_settings(tmp_path: Path, **overrides) -> Settings:
    return Settings(access_code=CODE, session_secret=SECRET, data_dir=tmp_path / "data",
                    frontend_origins=(ORIGIN,), **overrides)


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture
def app(settings):
    application = create_app(settings)
    yield application
    application.state.db.close()


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def authed(client):
    r = client.post("/api/auth/login", json={"code": CODE}, headers={"Origin": ORIGIN})
    assert r.status_code == 200
    return client


@pytest.fixture(scope="session")
def ffmpeg():
    exe = audio.find_ffmpeg()
    if not exe:
        pytest.skip("FFmpeg is not available")
    return exe


def make_tone(ffmpeg: str, path: Path, seconds: float = 3.0, freq: int = 440, codec_args=()) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", f"sine=frequency={freq}:duration={seconds}", *codec_args, str(path)], check=True)
    return path


@pytest.fixture
def music_library(tmp_path, ffmpeg):
    """A small library: one lossless file with tags, one low-bitrate MP3 named 'Artist - Title'."""
    from mutagen.flac import FLAC

    lib = tmp_path / "library"
    flac = make_tone(ffmpeg, lib / "01 sunrise.flac", 3.0, 440)
    tags = FLAC(str(flac))
    tags["title"], tags["artist"], tags["album"] = "Sunrise Tone", "The Testers", "Test Signals"
    tags.save()
    make_tone(ffmpeg, lib / "Sine Collective - Low Hum.mp3", 4.0, 220, ("-c:a", "libmp3lame", "-b:a", "128k"))
    return lib
