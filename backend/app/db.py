"""SQLite storage: settings, playlists, history, revoked sessions, library index."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_url TEXT, source TEXT,
    started_at REAL NOT NULL, updated_at REAL NOT NULL,
    total INTEGER NOT NULL, completed INTEGER NOT NULL, failed INTEGER NOT NULL,
    bytes INTEGER NOT NULL, quality INTEGER NOT NULL, folder TEXT, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revoked (sid TEXT PRIMARY KEY, exp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS library (
    path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL,
    title TEXT, artist TEXT, album TEXT, duration REAL, bitrate INTEGER,
    codec TEXT, lossless INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS art_cache (track_id TEXT PRIMARY KEY, url TEXT NOT NULL);
"""


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def execute(self, sql: str, params: tuple = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        with self._lock:
            self._conn.executemany(sql, rows)
            self._conn.commit()

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- settings
    def get_setting(self, key: str, default=None):
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value) -> None:
        self.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )

    # ---- sessions
    def revoke_session(self, sid: str, exp: float) -> None:
        self.execute("INSERT OR REPLACE INTO revoked(sid,exp) VALUES(?,?)", (sid, exp))
        self.execute("DELETE FROM revoked WHERE exp < ?", (time.time(),))

    def is_revoked(self, sid: str) -> bool:
        return self.one("SELECT 1 FROM revoked WHERE sid=?", (sid,)) is not None

    # ---- playlists
    def save_playlist(self, playlist: dict) -> None:
        self.execute(
            "INSERT OR REPLACE INTO playlists(id,data,created_at) VALUES(?,?,?)",
            (playlist["id"], json.dumps(playlist), time.time()),
        )

    def load_playlist(self, pid: str) -> dict | None:
        row = self.one("SELECT data FROM playlists WHERE id=?", (pid,))
        return json.loads(row["data"]) if row else None
