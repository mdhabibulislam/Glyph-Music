"""First-run setup: the access code is created once on the website, then locked."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

from conftest import ORIGIN, SECRET

MINE = "my-first-code-42"
THEIRS = "attacker-code-99"


def fresh_settings(tmp_path, name="fresh") -> Settings:
    return Settings(session_secret=SECRET, data_dir=tmp_path / name, frontend_origins=(ORIGIN,))


@pytest.fixture
def fresh(tmp_path):
    """A backend with no access code yet, as it is right after deployment."""
    app = create_app(fresh_settings(tmp_path))
    yield TestClient(app)
    app.state.db.close()


def test_nothing_works_before_the_code_is_set(fresh):
    assert fresh.get("/api/auth/status").json() == {"configured": False}
    assert fresh.get("/api/settings").status_code == 401
    r = fresh.post("/api/auth/login", json={"code": "anything-at-all"})
    assert r.status_code == 409 and r.json()["code"] == "setup_required"


def test_code_is_set_once_and_then_locked(fresh, tmp_path):
    assert fresh.post("/api/auth/setup", json={"code": "short"}).status_code == 422
    r = fresh.post("/api/auth/setup", json={"code": MINE})
    assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
    assert fresh.get("/api/settings").status_code == 200  # setting the code signs you in
    assert fresh.get("/api/auth/status").json() == {"configured": True}

    # Nobody can set it again: not a stranger, not even someone who is signed in.
    stranger = TestClient(fresh.app)
    for client in (fresh, stranger):
        again = client.post("/api/auth/setup", json={"code": THEIRS})
        assert again.status_code == 409 and again.json()["code"] == "already_configured"
    assert stranger.post("/api/auth/login", json={"code": THEIRS}).status_code == 401
    assert stranger.post("/api/auth/login", json={"code": MINE}).status_code == 200

    # Only a salted hash is stored, never the code.
    stored = fresh.app.state.db.get_setting("access_code_hash")
    assert set(stored) == {"salt", "hash"} and MINE not in str(stored)
    for f in (tmp_path / "fresh").glob("glyph.db*"):
        assert MINE.encode() not in f.read_bytes()


def test_code_survives_a_restart(tmp_path):
    first = create_app(fresh_settings(tmp_path, "persist"))
    assert TestClient(first).post("/api/auth/setup", json={"code": MINE}).status_code == 200
    first.state.db.close()
    second = create_app(fresh_settings(tmp_path, "persist"))
    c = TestClient(second)
    assert c.get("/api/auth/status").json() == {"configured": True}
    assert c.post("/api/auth/setup", json={"code": THEIRS}).status_code == 409
    assert c.post("/api/auth/login", json={"code": MINE}).status_code == 200
    second.state.db.close()


def test_setup_is_closed_when_a_code_is_set_in_env(client):
    assert client.get("/api/auth/status").json() == {"configured": True}
    assert client.post("/api/auth/setup", json={"code": THEIRS}).status_code == 409


def test_setup_refuses_cross_site_requests(fresh):
    r = fresh.post("/api/auth/setup", json={"code": THEIRS}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert fresh.get("/api/auth/status").json() == {"configured": False}


def test_old_sessions_die_when_the_code_is_reset(fresh):
    assert fresh.post("/api/auth/setup", json={"code": MINE}).status_code == 200
    assert fresh.get("/api/settings").status_code == 200
    # What reset-code.bat does: remove the stored hash.
    fresh.app.state.db.execute("DELETE FROM settings WHERE key=?", ("access_code_hash",))
    assert fresh.get("/api/settings").status_code == 401  # the old cookie no longer opens anything
    assert fresh.get("/api/auth/session").status_code == 401
    assert fresh.get("/api/auth/status").json() == {"configured": False}
    # A new code can now be created, and the cookie from the old one still does not work.
    old = fresh.cookies.get("glyph_session")
    assert TestClient(fresh.app).post("/api/auth/setup", json={"code": "second-code-2026"}).status_code == 200
    fresh.cookies.set("glyph_session", old)
    assert fresh.get("/api/settings").status_code == 401
