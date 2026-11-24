"""Signed tokens, login rate limiting, and path / URL safety helpers."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlparse


# ---------------------------------------------------------------- tokens
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: str, purpose: str, body: str) -> str:
    return _b64(hmac.new(secret.encode(), f"{purpose}.{body}".encode(), hashlib.sha256).digest())


def sign_token(secret: str, purpose: str, payload: dict, ttl_seconds: int) -> str:
    now = int(time.time())
    data = dict(payload, iat=now, exp=now + int(ttl_seconds))
    body = _b64(json.dumps(data, separators=(",", ":")).encode())
    return f"{body}.{_mac(secret, purpose, body)}"


def verify_token(secret: str, purpose: str, token: str | None) -> dict | None:
    """Return the payload if the signature is valid and the token has not expired."""
    if not token or len(token) > 2048 or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    if not hmac.compare_digest(sig, _mac(secret, purpose, body)):
        return None
    try:
        data = json.loads(_unb64(body))
    except Exception:
        return None
    if not isinstance(data, dict) or int(data.get("exp", 0)) < time.time():
        return None
    return data


def new_session_id() -> str:
    return secrets.token_urlsafe(18)


def code_matches(expected: str, supplied: str) -> bool:
    # Hash first so the comparison is constant-time regardless of length.
    a = hashlib.sha256(expected.encode()).digest()
    b = hashlib.sha256(supplied.encode()).digest()
    return hmac.compare_digest(a, b)


def hash_code(code: str) -> dict:
    """Salted scrypt hash of an access code. Only this is stored, never the code itself."""
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(code.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return {"salt": _b64(salt), "hash": _b64(digest)}


def code_matches_hash(stored: dict, supplied: str) -> bool:
    try:
        salt, expected = _unb64(stored["salt"]), _unb64(stored["hash"])
    except Exception:
        return False
    digest = hashlib.scrypt(supplied.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(digest, expected)


# ---------------------------------------------------------------- rate limit
class LoginLimiter:
    """Sliding-window limiter on failed attempts: per client and global."""

    def __init__(self, max_attempts: int, window_seconds: int, global_factor: int = 4):
        self.max = max_attempts
        self.window = window_seconds
        self.global_max = max_attempts * global_factor
        self._fails: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        q = self._fails.setdefault(key, deque())
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def retry_after(self, client: str) -> int:
        """Seconds the client must wait, or 0 if an attempt is allowed."""
        now = time.time()
        with self._lock:
            waits = []
            for key, limit in ((f"c:{client}", self.max), ("*", self.global_max)):
                q = self._prune(key, now)
                if len(q) >= limit:
                    waits.append(int(q[0] + self.window - now) + 1)
            return max(waits) if waits else 0

    def record_failure(self, client: str) -> int:
        """Record a failure and return the attempts left for this client."""
        now = time.time()
        with self._lock:
            for key in (f"c:{client}", "*"):
                self._prune(key, now).append(now)
            if len(self._fails) > 5000:  # bound memory under address spraying
                for k in [k for k, q in self._fails.items() if not q]:
                    del self._fails[k]
            return max(0, self.max - len(self._fails[f"c:{client}"]))

    def reset(self, client: str) -> None:
        with self._lock:
            self._fails.pop(f"c:{client}", None)


# ---------------------------------------------------------------- files
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_filename(name: str, fallback: str = "untitled", max_len: int = 120) -> str:
    """Make a string safe to use as a single Windows/POSIX path component."""
    name = _ILLEGAL.sub(" ", name or "")
    name = " ".join(name.split()).strip(" .")
    if not name:
        name = fallback
    if name.split(".")[0].upper() in _RESERVED:
        name = f"_{name}"
    return name[:max_len].rstrip(" .") or fallback


def ensure_within(base: Path, candidate: Path) -> Path:
    """Resolve candidate and guarantee it stays inside base (blocks path traversal)."""
    base_r = base.resolve()
    cand_r = candidate.resolve()
    if cand_r != base_r and base_r not in cand_r.parents:
        raise ValueError("Path escapes its allowed directory")
    return cand_r


# ---------------------------------------------------------------- URLs
_SPOTIFY_ID = r"[A-Za-z0-9]{22}"
_SPOTIFY_URL = re.compile(
    rf"^https://open\.spotify\.com/(?:intl-[a-z]{{2}}(?:-[A-Za-z]{{2}})?/)?(?:embed/)?(playlist|album|track)/({_SPOTIFY_ID})/?(?:\?[^\s#]*)?(?:#\S*)?$"
)
_SPOTIFY_URI = re.compile(rf"^spotify:(playlist|album|track):({_SPOTIFY_ID})$")


def parse_spotify_url(url: str) -> tuple[str, str]:
    """Return (kind, id). Only the kind and ID are ever used to build outbound requests,
    so a user-supplied URL can never steer the server to another host (SSRF)."""
    url = (url or "").strip()
    if len(url) > 400:
        raise ValueError("That link is too long to be a Spotify link.")
    m = _SPOTIFY_URL.match(url) or _SPOTIFY_URI.match(url)
    if not m:
        if re.match(r"^https?://(spotify\.link|spotify\.app\.link)/", url):
            raise ValueError("Short spotify.link URLs aren't supported. Open it and copy the full open.spotify.com link.")
        raise ValueError("Paste a Spotify playlist, album or song link (https://open.spotify.com/...).")
    return m.group(1), m.group(2)


_IMAGE_HOST_SUFFIXES = (".scdn.co", ".spotifycdn.com")


def is_allowed_image_url(url: str | None) -> bool:
    if not url or len(url) > 500:
        return False
    try:
        p = urlparse(url)
    except ValueError:
        return False
    host = (p.hostname or "").lower()
    return (
        p.scheme == "https"
        and p.port in (None, 443)
        and not p.username
        and any(host.endswith(s) for s in _IMAGE_HOST_SUFFIXES)
    )
