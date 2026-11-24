"""Local music library: the authorised audio source. Scans tags, fuzzy-matches tracks."""
from __future__ import annotations

import os
import re
import threading
import time
import unicodedata
from pathlib import Path

import mutagen
from rapidfuzz import fuzz, process

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".aiff", ".aif", ".wma", ".wv", ".ape"}
LOSSLESS_TYPES = {"FLAC", "WAVE", "AIFF", "WavPack", "MonkeysAudio"}
MATCH_THRESHOLD = 82.0

_PAREN = re.compile(r"[\(\[][^\)\]]*[\)\]]")
_FEAT = re.compile(r"\b(feat\.?|ft\.?|featuring)\b.*", re.I)
_SUFFIX = re.compile(r"\s+-\s+.*\b(remaster(ed)?|version|edit|mix|mono|stereo|deluxe|bonus|single|from)\b.*$", re.I)


def _basic(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower().replace("&", " and ")
    return " ".join(re.sub(r"[^\w\s]", " ", s).split())


def norm(s: str) -> str:
    """Normalise a title/artist for comparison: drop accents, punctuation, '(feat. X)', '- Remastered'."""
    stripped = _SUFFIX.sub("", _PAREN.sub(" ", _FEAT.sub("", s or "")))
    return _basic(stripped) or _basic(s)


def _first(tags, key: str) -> str:
    try:
        v = tags.get(key)
    except Exception:
        return ""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else ""
    return str(v).strip() if v else ""


def read_audio_info(path: Path) -> dict | None:
    """Tags + technical info for one file, or None if it is not readable audio."""
    try:
        f = mutagen.File(str(path), easy=True)
    except Exception:
        return None
    if f is None or not getattr(f, "info", None):
        return None
    info = f.info
    kind = type(f).__name__.replace("Easy", "")
    codec = {"MP3": "mp3", "FLAC": "flac", "MP4": "aac", "OggVorbis": "vorbis", "OggOpus": "opus",
             "WAVE": "wav", "AIFF": "aiff", "ASF": "wma"}.get(kind, kind.lower())
    lossless = kind in LOSSLESS_TYPES
    if kind == "MP4" and "alac" in str(getattr(info, "codec", "")).lower():
        codec, lossless = "alac", True
    duration = float(getattr(info, "length", 0) or 0)
    bitrate = int(getattr(info, "bitrate", 0) or 0)
    size = path.stat().st_size
    if not bitrate and duration > 0:
        bitrate = int(size * 8 / duration)
    tags = f.tags or {}
    title, artist, album = _first(tags, "title"), _first(tags, "artist"), _first(tags, "album")
    if not title:  # fall back to "Artist - Title.ext"
        stem = re.sub(r"^\d{1,3}[\s.\-_]+", "", path.stem)
        if " - " in stem:
            a, t = stem.split(" - ", 1)
            artist, title = artist or a.strip(), t.strip()
        else:
            title = stem.strip()
    return {"title": title, "artist": artist, "album": album, "duration": duration,
            "bitrate": bitrate, "codec": codec, "lossless": lossless, "size": size}


class Library:
    def __init__(self, db):
        self.db = db
        self._lock = threading.Lock()
        self._rows: list[dict] = []
        self._titles: list[str] = []
        self.version = 0
        self.scan = {"running": False, "scanned": 0, "found": 0, "error": "", "finished_at": 0.0}
        self._reload()

    # ---- settings
    def folders(self) -> list[str]:
        return list(self.db.get_setting("library_folders", []) or [])

    # ---- index
    def _reload(self) -> None:
        rows = [dict(r) for r in self.db.query("SELECT * FROM library")]
        for r in rows:
            r["ntitle"], r["nartist"] = norm(r["title"] or ""), norm(r["artist"] or "")
        with self._lock:
            self._rows = rows
            self._titles = [r["ntitle"] for r in rows]
            self.version += 1

    def count(self) -> int:
        return len(self._rows)

    def start_scan(self) -> bool:
        with self._lock:
            if self.scan["running"]:
                return False
            self.scan = {"running": True, "scanned": 0, "found": 0, "error": "", "finished_at": 0.0}
        threading.Thread(target=self._scan, name="library-scan", daemon=True).start()
        return True

    def scan_blocking(self) -> None:
        with self._lock:
            self.scan = {"running": True, "scanned": 0, "found": 0, "error": "", "finished_at": 0.0}
        self._scan()

    def _scan(self) -> None:
        try:
            known = {r["path"]: (r["mtime"], r["size"]) for r in self.db.query("SELECT path, mtime, size FROM library")}
            seen: set[str] = set()
            batch: list[tuple] = []
            for folder in self.folders():
                root = Path(folder)
                if not root.is_dir():
                    continue
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                    for name in filenames:
                        p = Path(dirpath) / name
                        if p.suffix.lower() not in AUDIO_EXTS:
                            continue
                        self.scan["scanned"] += 1
                        try:
                            st = p.stat()
                        except OSError:
                            continue
                        key = str(p)
                        seen.add(key)
                        if known.get(key) == (st.st_mtime, st.st_size):
                            self.scan["found"] += 1
                            continue
                        info = read_audio_info(p)
                        if not info or info["duration"] <= 0:
                            continue
                        self.scan["found"] += 1
                        batch.append((key, st.st_mtime, st.st_size, info["title"], info["artist"], info["album"],
                                      info["duration"], info["bitrate"], info["codec"], int(info["lossless"])))
                        if len(batch) >= 200:
                            self._flush(batch)
            self._flush(batch)
            gone = [(p,) for p in known if p not in seen]
            if gone:
                self.db.executemany("DELETE FROM library WHERE path=?", gone)
        except Exception as e:  # surface, don't crash the worker
            self.scan["error"] = str(e)
        finally:
            self._reload()
            self.scan["running"] = False
            self.scan["finished_at"] = time.time()

    def _flush(self, batch: list[tuple]) -> None:
        if batch:
            self.db.executemany(
                "INSERT OR REPLACE INTO library(path,mtime,size,title,artist,album,duration,bitrate,codec,lossless)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)", batch)
            batch.clear()

    # ---- matching
    def match(self, track: dict) -> dict | None:
        """Best library file for a track, or None. Uses title + artist similarity and duration."""
        with self._lock:
            rows, titles = self._rows, self._titles
        if not rows:
            return None
        ntitle, nartist = norm(track["title"]), norm(track.get("artist", ""))
        primary = norm(track["artists"][0]) if track.get("artists") else nartist
        want = (track.get("duration_ms") or 0) / 1000
        best, best_score = None, 0.0
        for _, tscore, i in process.extract(ntitle, titles, scorer=fuzz.ratio, score_cutoff=80, limit=40):
            row = rows[i]
            have = row["duration"] or 0
            diff = abs(have - want) if want and have else 0
            if diff > 12:
                continue
            if row["nartist"] and nartist:
                ascore = max(fuzz.token_set_ratio(nartist, row["nartist"]), fuzz.partial_ratio(primary, row["nartist"]))
                if ascore < 60:
                    continue
                score = 0.6 * tscore + 0.4 * ascore
            else:  # no artist on one side: demand a near-exact title and a tight duration
                if tscore < 93 or (want and have and diff > 5):
                    continue
                score = tscore * 0.92
            score -= diff * 0.6
            score += 1.5 if row["lossless"] else min(1.0, (row["bitrate"] or 0) / 320000)
            if score > best_score:
                best, best_score = row, score
        if best is None or best_score < MATCH_THRESHOLD:
            return None
        return {"path": best["path"], "score": round(min(best_score, 100.0), 1), "size": best["size"],
                "duration": best["duration"], "bitrate": best["bitrate"], "codec": best["codec"],
                "lossless": bool(best["lossless"]), "album": best["album"] or ""}
