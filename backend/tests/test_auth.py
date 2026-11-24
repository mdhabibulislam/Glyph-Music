"""Authentication: nothing is reachable without a valid, unexpired, unrevoked session."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings
from app.main import COOKIE, create_app
from app.security import sign_token, verify_token

from conftest import CODE, ORIGIN, SECRET, make_settings

PROTECTED = [
    ("get", "/api/settings"), ("put", "/api/settings"), ("get", "/api/history"),
    ("delete", "/api/history/" + "a" * 32), ("post", "/api/playlist/fetch"), ("post", "/api/playlist/import-csv"),
    ("post", "/api/library/scan"), ("get", "/api/jobs/" + "a" * 32), ("post", "/api/jobs/" + "a" * 32 + "/start"),
    ("post", "/api/jobs/" + "a" * 32 + "/cancel"), ("post", "/api/jobs/" + "a" * 32 + "/retry"),
    ("get", "/api/jobs/" + "a" * 32 + "/events"), ("get", "/api/jobs/" + "a" * 32 + "/zip"),
    ("get", "/api/jobs/" + "a" * 32 + "/zip-link"), ("get", "/api/jobs/" + "a" * 32 + "/tracks/0/file"),
    ("get", "/api/jobs/" + "a" * 32 + "/tracks/0/art"), ("get", "/api/does-not-exist"), ("get", "/docs"),
    ("get", "/openapi.json"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_every_route_requires_a_session(client, method, path):
    r = getattr(client, method)(path)
    assert r.status_code == 401, f"{method.upper()} {path} answered {r.status_code} without a session"


def test_every_registered_route_is_closed_by_default(app, client):
    """Walk the real route table so a newly added endpoint can't be forgotten."""
    public = {"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/session", "/api/auth/status",
              "/api/auth/setup", "/api/dl/{token}"}
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api") or path in public:
            continue
        url = path.replace("{job_id}", "a" * 32).replace("{index}", "0")
        for method in route.methods - {"HEAD", "OPTIONS"}:
            assert client.request(method, url).status_code == 401, f"{method} {path} is open"


def test_wrong_code_is_rejected(client):
    r = client.post("/api/auth/login", json={"code": "nope"})
    assert r.status_code == 401
    assert COOKIE not in r.cookies
    assert client.get("/api/settings").status_code == 401


def test_login_sets_httponly_cookie_and_grants_access(client):
    r = client.post("/api/auth/login", json={"code": CODE})
    assert r.status_code == 200
    header = r.headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=lax" in header and "path=/" in header
    assert f"max-age={7 * 86400}" in header  # remembered for seven days
    assert CODE not in r.text
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/auth/session").json()["authenticated"] is True


def test_cookie_is_secure_behind_https(client):
    r = client.post("/api/auth/login", json={"code": CODE}, headers={"X-Forwarded-Proto": "https"})
    assert "secure" in r.headers["set-cookie"].lower()


def test_logout_revokes_the_session_server_side(client):
    client.post("/api/auth/login", json={"code": CODE})
    stolen = client.cookies.get(COOKIE)
    assert client.post("/api/auth/logout").status_code == 200
    client.cookies.set(COOKIE, stolen)  # replaying the old cookie must not work
    assert client.get("/api/settings").status_code == 401


def test_forged_tampered_and_expired_cookies_fail(client, settings):
    forged = sign_token("x" * 48, "session", {"sid": "abc"}, 3600)
    expired = sign_token(SECRET, "session", {"sid": "abc"}, -10)
    wrong_purpose = sign_token(SECRET, "download", {"sid": "abc", "job": "a" * 32}, 3600)
    unbound = sign_token(SECRET, "session", {"sid": "abc"}, 3600)  # right key, but not tied to the code
    client.post("/api/auth/login", json={"code": CODE})
    good = client.cookies.get(COOKIE)
    client.cookies.clear()
    body, sig = good.split(".")
    tampered = body[:-2] + ("AA" if body[-2:] != "AA" else "BB") + "." + sig
    for bad in (forged, expired, wrong_purpose, tampered, unbound, "garbage", "a.b", ""):
        client.cookies.set(COOKIE, bad)
        assert client.get("/api/settings").status_code == 401, bad
    client.cookies.set(COOKIE, good)
    assert client.get("/api/settings").status_code == 200


def test_rate_limit_locks_out_after_repeated_failures(tmp_path):
    app = create_app(make_settings(tmp_path, login_max_attempts=3))
    c = TestClient(app)
    for _ in range(3):
        assert c.post("/api/auth/login", json={"code": "wrong"}).status_code == 401
    locked = c.post("/api/auth/login", json={"code": "wrong"})
    assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0
    # Even the right code is refused while locked out.
    assert c.post("/api/auth/login", json={"code": CODE}).status_code == 429
    app.state.db.close()


def test_cross_site_posts_are_refused(authed):
    r = authed.post("/api/library/scan", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert authed.post("/api/library/scan", headers={"Origin": ORIGIN}).status_code == 200


def test_cors_only_allows_the_configured_frontend(client):
    ok = client.options("/api/settings", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    bad = client.options("/api/settings", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_signed_download_links_cannot_be_forged(client):
    assert client.get("/api/dl/garbage").status_code == 403
    session_token = sign_token(SECRET, "session", {"job": "a" * 32}, 300)  # wrong purpose
    assert client.get(f"/api/dl/{session_token}").status_code == 403
    expired = sign_token(SECRET, "download", {"job": "a" * 32}, -5)
    assert client.get(f"/api/dl/{expired}").status_code == 403


def test_tokens_expire():
    token = sign_token(SECRET, "session", {"sid": "x"}, 1)
    assert verify_token(SECRET, "session", token)["sid"] == "x"
    time.sleep(2.1)
    assert verify_token(SECRET, "session", token) is None


@pytest.mark.parametrize("code,secret", [("long-enough-code", ""), ("short", "s" * 48), ("long-enough-code", "tooshort"),
                                         ("x" * 40, "x" * 40)])
def test_refuses_to_start_with_missing_or_weak_secrets(tmp_path, code, secret):
    with pytest.raises(ConfigError):
        create_app(Settings(access_code=code, session_secret=secret, data_dir=tmp_path / "d"))
