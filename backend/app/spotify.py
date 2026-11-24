"""Playlist metadata: Spotify's public embed pages (no API key) and CSV import.

Only metadata is read from Spotify. Audio never comes from Spotify.
"""
from __future__ import annotations

import csv
import io
import json
import re
import ssl
import uuid
from concurrent.futures import ThreadPoolExecutor, wait

import httpx

from .security import is_allowed_image_url, parse_spotify_url

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
EMBED_LIMIT = 100  # Spotify's embed page lists at most this many playlist tracks
MAX_HTML_BYTES = 8 * 1024 * 1024
MAX_CSV_BYTES = 5 * 1024 * 1024
_NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


class MetadataError(Exception):
    """A user-facing explanation of why metadata could not be retrieved."""

    def __init__(self, message: str, code: str = "metadata_error"):
        super().__init__(message)
        self.code = code


def _get_limited(client: httpx.Client, url: str, max_bytes: int) -> bytes:
    with client.stream("GET", url) as r:
        if r.status_code in (301, 302, 303, 307, 308):
            raise MetadataError("Spotify redirected the request; the link may be private or region-locked.", "blocked")
        if r.status_code == 404:
            raise MetadataError("Spotify says this link doesn't exist, or it's private.", "not_found")
        if r.status_code == 429:
            raise MetadataError("Spotify is rate-limiting requests right now. Try again in a minute.", "rate_limited")
        if r.status_code != 200:
            raise MetadataError(f"Spotify returned HTTP {r.status_code}.", "blocked")
        chunks, total = [], 0
        for chunk in r.iter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise MetadataError("Spotify's response was unexpectedly large.", "blocked")
            chunks.append(chunk)
        return b"".join(chunks)


def _client() -> httpx.Client:
    # follow_redirects stays off: every outbound URL is built from a validated ID.
    return httpx.Client(timeout=httpx.Timeout(15.0, connect=8.0), headers={"User-Agent": UA}, follow_redirects=False)


def _best_image(sources) -> str | None:
    best, best_w = None, -1
    for s in sources or []:
        if not isinstance(s, dict):
            continue
        url = s.get("url")
        w = s.get("width") or s.get("maxWidth") or 0
        if is_allowed_image_url(url) and w >= best_w:
            best, best_w = url, w
    return best


def _entity_cover(entity: dict) -> str | None:
    return _best_image((entity.get("coverArt") or {}).get("sources")) or _best_image(
        (entity.get("visualIdentity") or {}).get("image")
    )


def _track(index: int, *, title, artists, album="", duration_ms=0, spotify_id="", artwork_url=None, playable=True) -> dict:
    artists = [a.strip() for a in artists if a and a.strip()]
    return {
        "index": index,
        "spotify_id": spotify_id,
        "title": (title or "").strip()[:300],
        "artists": artists[:12],
        "artist": ", ".join(artists)[:300],
        "album": (album or "").strip()[:300],
        "duration_ms": max(0, int(duration_ms or 0)),
        "artwork_url": artwork_url if is_allowed_image_url(artwork_url) else None,
        "playable": bool(playable),
    }


def _split_artists(text: str) -> list[str]:
    return [a for a in re.split(r"\s*[,;·]\s*| ", text or "") if a]


def parse_embed_html(html: str, kind: str, sid: str) -> dict:
    """Turn an embed page into our playlist shape. Defensive: Spotify changes this often."""
    m = _NEXT_DATA.search(html)
    if not m:
        raise MetadataError("Spotify's page layout changed and couldn't be read. Use CSV import instead.", "layout")
    try:
        data = json.loads(m.group(1))
        entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    except Exception:
        raise MetadataError(
            "Spotify didn't share this item's details (it may be private or unavailable). Use CSV import instead.",
            "layout",
        )
    cover = _entity_cover(entity)
    name = entity.get("name") or entity.get("title") or "Spotify " + kind
    tracks: list[dict] = []
    if kind == "track":
        artists = [a.get("name", "") for a in entity.get("artists") or [] if isinstance(a, dict)]
        if not artists and entity.get("subtitle"):
            artists = _split_artists(entity["subtitle"])
        tracks.append(
            _track(0, title=name, artists=artists, duration_ms=entity.get("duration"), spotify_id=sid,
                   artwork_url=cover, playable=entity.get("isPlayable", True))
        )
    else:
        album_name = name if kind == "album" else ""
        for item in entity.get("trackList") or []:
            if not isinstance(item, dict) or not item.get("title"):
                continue
            uri = item.get("uri") or ""
            tid = uri.split(":")[-1] if uri.startswith("spotify:track:") else ""
            tracks.append(
                _track(len(tracks), title=item["title"], artists=_split_artists(item.get("subtitle", "")),
                       album=album_name, duration_ms=item.get("duration"), spotify_id=tid,
                       artwork_url=cover if kind == "album" else None, playable=item.get("isPlayable", True))
            )
    if not tracks:
        raise MetadataError("No songs were found at that link.", "empty")
    return {
        "id": uuid.uuid4().hex,
        "kind": kind,
        "spotify_id": sid,
        "source": "spotify",
        "source_url": f"https://open.spotify.com/{kind}/{sid}",
        "name": str(name)[:200],
        "owner": str(entity.get("subtitle") or "")[:200] if kind != "track" else "",
        "cover_url": cover,
        "tracks": tracks,
        "truncated": kind == "playlist" and len(tracks) >= EMBED_LIMIT,
    }


def _fetch_track_art(client: httpx.Client, track_id: str) -> str | None:
    try:
        raw = _get_limited(client, f"https://open.spotify.com/oembed?url=spotify:track:{track_id}", 64 * 1024)
        url = json.loads(raw).get("thumbnail_url")
        return url if is_allowed_image_url(url) else None
    except Exception:
        return None


def fill_track_artwork(playlist: dict, db=None, deadline_s: float = 8.0) -> None:
    """Best-effort per-track artwork via Spotify's public oEmbed endpoint, cached in SQLite."""
    todo = [t for t in playlist["tracks"] if not t.get("artwork_url") and t.get("spotify_id")]
    if db is not None:
        for t in todo:
            row = db.one("SELECT url FROM art_cache WHERE track_id=?", (t["spotify_id"],))
            if row:
                t["artwork_url"] = row["url"]
        todo = [t for t in todo if not t.get("artwork_url")]
    if not todo:
        return
    with _client() as client, ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_track_art, client, t["spotify_id"]): t for t in todo}
        done, pending = wait(futures, timeout=deadline_s)
        for f in pending:
            f.cancel()
        for f in done:
            url = f.result()
            if url:
                futures[f]["artwork_url"] = url
                if db is not None:
                    db.execute("INSERT OR REPLACE INTO art_cache(track_id,url) VALUES(?,?)", (futures[f]["spotify_id"], url))


def fetch_playlist(url: str, max_tracks: int, db=None) -> dict:
    kind, sid = parse_spotify_url(url)
    try:
        with _client() as client:
            html = _get_limited(client, f"https://open.spotify.com/embed/{kind}/{sid}", MAX_HTML_BYTES).decode("utf-8", "replace")
    except MetadataError:
        raise
    except httpx.ConnectError as e:
        if isinstance(e.__cause__, ssl.SSLError) or "CERTIFICATE" in str(e).upper():
            raise MetadataError(
                "This network intercepts or blocks open.spotify.com (the TLS certificate wasn't Spotify's). "
                "Try another network, or use CSV import.",
                "network_blocked",
            )
        raise MetadataError("Couldn't reach Spotify. Check your internet connection, or use CSV import.", "network")
    except httpx.HTTPError:
        raise MetadataError("Couldn't reach Spotify. Check your internet connection, or use CSV import.", "network")
    playlist = parse_embed_html(html, kind, sid)
    playlist["tracks"] = playlist["tracks"][:max_tracks]
    if kind == "playlist":
        try:
            fill_track_artwork(playlist, db)
        except Exception:
            pass  # artwork is optional
    mark_duplicates(playlist)
    return playlist


# ---------------------------------------------------------------- CSV import
_COLS = {
    "title": ("track name", "title", "name", "track", "song", "song name", "track title"),
    "artist": ("artist name(s)", "artist names", "artist name", "artists", "artist"),
    "album": ("album name", "album"),
    "duration": ("duration (ms)", "track duration (ms)", "duration_ms", "duration ms", "duration", "length", "time"),
    "uri": ("track uri", "spotify uri", "uri", "track url", "spotify id", "track id"),
    "image": ("album image url", "image url", "artwork url"),
}


def _parse_duration(value: str, is_ms: bool = False) -> int:
    value = (value or "").strip()
    if not value:
        return 0
    if re.fullmatch(r"\d+(\.\d+)?", value):
        n = float(value)
        # A "(ms)" column is taken at its word; otherwise big numbers are ms, small ones seconds.
        return int(n if is_ms or n > 30000 else n * 1000)
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", value)
    if m:
        return ((int(m.group(1) or 0) * 60 + int(m.group(2))) * 60 + int(m.group(3))) * 1000
    return 0


def import_csv(text: str, name: str, max_tracks: int) -> dict:
    """Accepts Exportify-style exports or any CSV with title + artist columns."""
    if len(text.encode("utf-8", "ignore")) > MAX_CSV_BYTES:
        raise MetadataError("That CSV is larger than 5 MB.", "too_large")
    text = text.lstrip("﻿")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = [h.strip().lower() for h in next(reader)]
    except StopIteration:
        raise MetadataError("That CSV is empty.", "empty")
    col = {}
    for key, names in _COLS.items():
        for n in names:
            if n in header:
                col[key] = header.index(n)
                break
    if "title" not in col:
        raise MetadataError("The CSV needs a header row with at least a 'Track Name' (or 'Title') column.", "bad_csv")

    duration_is_ms = "duration" in col and "ms" in header[col["duration"]]

    def cell(row, key):
        i = col.get(key)
        return row[i].strip() if i is not None and i < len(row) else ""

    tracks = []
    for row in reader:
        title = cell(row, "title")
        if not title:
            continue
        uri = cell(row, "uri")
        m = re.search(r"(?:track[:/])([A-Za-z0-9]{22})", uri) or re.fullmatch(r"([A-Za-z0-9]{22})", uri)
        tracks.append(
            _track(len(tracks), title=title, artists=_split_artists(cell(row, "artist")), album=cell(row, "album"),
                   duration_ms=_parse_duration(cell(row, "duration"), duration_is_ms),
                   spotify_id=m.group(1) if m else "",
                   artwork_url=cell(row, "image") or None)
        )
        if len(tracks) >= max_tracks:
            break
    if not tracks:
        raise MetadataError("No songs were found in that CSV.", "empty")
    name = re.sub(r"\.csv$", "", (name or "").strip(), flags=re.I)[:200] or "Imported playlist"
    playlist = {
        "id": uuid.uuid4().hex, "kind": "playlist", "spotify_id": "", "source": "csv", "source_url": "",
        "name": name, "owner": "", "cover_url": next((t["artwork_url"] for t in tracks if t["artwork_url"]), None),
        "tracks": tracks, "truncated": False,
    }
    mark_duplicates(playlist)
    return playlist


def mark_duplicates(playlist: dict) -> None:
    """Flag repeated songs so they are only processed once."""
    from .library import norm

    seen: dict[tuple, int] = {}
    for t in playlist["tracks"]:
        key = (t["spotify_id"],) if t["spotify_id"] else (norm(t["title"]), norm(t["artist"]))
        alt = (norm(t["title"]), norm(t["artist"]))
        first = seen.get(key, seen.get(alt))
        t["duplicate_of"] = first
        if first is None:
            seen[key] = t["index"]
            seen[alt] = t["index"]
