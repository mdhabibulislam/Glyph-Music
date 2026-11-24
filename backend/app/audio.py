"""FFmpeg conversion, ID3 tagging and artwork handling."""
from __future__ import annotations

import base64
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable

import httpx
import mutagen
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TIT2, TPE1, TRCK
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

from .config import QUALITIES
from .security import is_allowed_image_url

MAX_ART_BYTES = 5 * 1024 * 1024


class Cancelled(Exception):
    pass


class AudioError(Exception):
    pass


def find_ffmpeg(configured: str = "") -> str | None:
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def plan_bitrate(codec: str, source_bps: int, lossless: bool, target_kbps: int) -> tuple[int, bool]:
    """Return (output kbps, passthrough).

    Lossy sources are never encoded above their own bitrate: that would only inflate the
    file without adding quality. MP3 sources at or below the target are copied untouched.
    """
    src_k = round((source_bps or 0) / 1000)
    if codec == "mp3" and 0 < src_k <= target_kbps + 8:
        return src_k, True
    if lossless or src_k <= 0:
        return target_kbps, False
    tier = next((q for q in QUALITIES if q >= src_k - 8), QUALITIES[-1])
    return min(tier, target_kbps), False


def convert_to_mp3(ffmpeg: str, src: Path, dst: Path, kbps: int, duration: float,
                   on_progress: Callable[[float], None], cancel: threading.Event) -> None:
    """Encode src to MP3. Arguments are passed as a list (no shell), paths are absolute."""
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src.resolve()), "-vn", "-map", "0:a:0", "-map_metadata", "-1",
            "-c:a", "libmp3lame", "-b:a", f"{int(kbps)}k", "-progress", "pipe:1", "-f", "mp3", str(dst.resolve())]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err,
                                text=True, creationflags=flags)
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                if cancel.is_set():
                    raise Cancelled()
                if line.startswith(("out_time_us=", "out_time_ms=")) and duration > 0:
                    try:
                        on_progress(min(1.0, int(line.split("=", 1)[1]) / 1_000_000 / duration))
                    except ValueError:
                        pass
            code = proc.wait(timeout=60)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        if code != 0:
            err.seek(0)
            detail = err.read(2000).decode("utf-8", "replace").strip().splitlines()
            raise AudioError("FFmpeg could not convert this file" + (f": {detail[-1]}" if detail else "."))


def extract_embedded_art(path: Path) -> tuple[bytes, str] | None:
    """Cover art stored inside an audio file, if any."""
    try:
        f = mutagen.File(str(path))
    except Exception:
        return None
    if f is None:
        return None
    try:
        if isinstance(f, FLAC) and f.pictures:
            return f.pictures[0].data, f.pictures[0].mime or "image/jpeg"
        if isinstance(f, MP4) and f.tags and f.tags.get("covr"):
            cover = f.tags["covr"][0]
            return bytes(cover), "image/png" if cover.imageformat == MP4Cover.FORMAT_PNG else "image/jpeg"
        tags = f.tags
        if tags is None:
            return None
        for key in list(tags.keys()):
            if str(key).startswith("APIC"):
                return tags[key].data, tags[key].mime or "image/jpeg"
        blocks = tags.get("metadata_block_picture") if hasattr(tags, "get") else None
        if blocks:
            pic = Picture(base64.b64decode(blocks[0]))
            return pic.data, pic.mime or "image/jpeg"
    except Exception:
        return None
    return None


def fetch_artwork(url: str | None) -> tuple[bytes, str] | None:
    """Download cover art, only from allow-listed Spotify image hosts, with a size cap."""
    if not is_allowed_image_url(url):
        return None
    try:
        with httpx.Client(timeout=10.0, follow_redirects=False) as client, client.stream("GET", url) as r:
            mime = r.headers.get("content-type", "").split(";")[0].strip().lower()
            if r.status_code != 200 or mime not in ("image/jpeg", "image/png"):
                return None
            data = b""
            for chunk in r.iter_bytes():
                data += chunk
                if len(data) > MAX_ART_BYTES:
                    return None
            return data, mime
    except httpx.HTTPError:
        return None


def tag_mp3(path: Path, *, title: str, artist: str, album: str, track_no: int | None,
            art: tuple[bytes, str] | None) -> None:
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    for frame in ("TIT2", "TPE1", "TALB"):
        tags.delall(frame)
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))
    if album:
        tags.add(TALB(encoding=3, text=album))
    tags.delall("TRCK")
    if track_no:
        tags.add(TRCK(encoding=3, text=str(track_no)))
    if art:
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=art[1], type=3, desc="Cover", data=art[0]))
    tags.save(str(path), v2_version=3)


def verify_mp3(path: Path) -> tuple[float, int]:
    """Return (seconds, kbps) for a healthy MP3; raise AudioError for a broken one."""
    try:
        info = MP3(str(path)).info
    except Exception:
        raise AudioError("The finished file is not a valid MP3.")
    if info.length < 0.5 or path.stat().st_size < 1024:
        raise AudioError("The finished file is incomplete.")
    return float(info.length), round(info.bitrate / 1000)
