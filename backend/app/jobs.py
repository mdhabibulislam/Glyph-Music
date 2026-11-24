"""Download sessions: background workers, real progress, history and ZIP contents."""
from __future__ import annotations

import csv
import io
import json
import os
import shutil
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from . import audio
from .audio import AudioError, Cancelled
from .config import QUALITIES, Settings
from .security import ensure_within, safe_filename

ACTIVE = {"pending", "searching", "matched", "downloading", "converting"}
TERMINAL = {"completed", "failed", "unavailable", "cancelled"}
MB = 1024 * 1024

DEFAULT_MUSIC = {
    "default_quality": 320,
    "max_concurrent": 2,
    "download_folder": "",
    "auto_zip": True,
    "include_artwork": True,
    "include_track_numbers": True,
    "auto_cleanup": True,
}


class JobError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class TrackState:
    __slots__ = ("index", "status", "progress", "error", "note", "file", "size", "bitrate", "quality", "match", "v")

    def __init__(self, index: int):
        self.index = index
        self.status = "idle"
        self.progress = 0.0
        self.error = ""
        self.note = ""
        self.file = ""
        self.size = 0
        self.bitrate = 0
        self.quality = 0
        self.match: dict | None = None
        self.v = 0


class Job:
    def __init__(self, playlist: dict, folder: Path):
        self.id: str = playlist["id"]
        self.playlist = playlist
        self.folder = folder
        self.tracks = [TrackState(t["index"]) for t in playlist["tracks"]]
        self.lock = threading.RLock()
        self.version = 1
        self.cancel = threading.Event()
        self.outstanding = 0
        self.batch: set[int] = set()
        self.batch_started = 0.0
        self.started_at = 0.0
        self.quality = 320
        self.bytes_done = 0
        self.samples: deque[tuple[float, int]] = deque(maxlen=120)
        self.executor: ThreadPoolExecutor | None = None
        self.library_version = -1
        self.names = self._build_names()

    def _build_names(self) -> dict[int, str]:
        names, used = {}, set()
        for t in self.playlist["tracks"]:
            if t.get("duplicate_of") is not None:
                continue
            base = safe_filename(f"{t['artist'] or 'Unknown Artist'} - {t['title']}", max_len=140)
            name, n = base, 2
            while name.lower() in used:
                name, n = f"{base} ({n})", n + 1
            used.add(name.lower())
            names[t["index"]] = name + ".mp3"
        return names

    def touch(self, ts: TrackState | None = None) -> None:
        with self.lock:
            self.version += 1
            if ts is not None:
                ts.v = self.version

    def set(self, ts: TrackState, status: str | None = None, **fields) -> None:
        with self.lock:
            if status:
                ts.status = status
            for k, v in fields.items():
                setattr(ts, k, v)
            self.touch(ts)

    def add_bytes(self, n: int) -> None:
        with self.lock:
            self.bytes_done += n
            now = time.time()
            if not self.samples or now - self.samples[-1][0] >= 0.2:
                self.samples.append((now, self.bytes_done))

    def speed(self) -> float:
        with self.lock:
            now = time.time()
            recent = [s for s in self.samples if now - s[0] <= 3.0]
            if len(recent) < 2 or recent[-1][0] - recent[0][0] <= 0:
                return 0.0
            return (recent[-1][1] - recent[0][1]) / (recent[-1][0] - recent[0][0])


class JobManager:
    def __init__(self, settings: Settings, db, library):
        self.settings = settings
        self.db = db
        self.library = library
        self.jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self.tmp_root = settings.data_dir / "tmp"
        self.ffmpeg = audio.find_ffmpeg(settings.ffmpeg_path)
        shutil.rmtree(self.tmp_root, ignore_errors=True)  # leftovers from a previous run

    # ---------------------------------------------------------- settings
    def music(self) -> dict:
        return {**DEFAULT_MUSIC, **(self.db.get_setting("music", {}) or {})}

    def download_root(self) -> Path:
        folder = self.music()["download_folder"]
        return Path(folder) if folder else self.settings.data_dir / "downloads"

    # ---------------------------------------------------------- lifecycle
    def create(self, playlist: dict) -> Job:
        self.db.save_playlist(playlist)
        folder = self.download_root() / f"{safe_filename(playlist['name'], 'Playlist', 80)} [{playlist['id'][:6]}]"
        job = Job(playlist, folder)
        self._rematch(job)
        with self._lock:
            self.jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            job = self.jobs.get(job_id)
        if job is None:
            playlist = self.db.load_playlist(job_id)
            if playlist is None:
                return None
            row = self.db.one("SELECT * FROM history WHERE id=?", (job_id,))
            folder = Path(row["folder"]) if row and row["folder"] else (
                self.download_root() / f"{safe_filename(playlist['name'], 'Playlist', 80)} [{job_id[:6]}]")
            job = Job(playlist, folder)
            if row:
                job.quality, job.started_at = row["quality"], row["started_at"]
                for i, saved in enumerate(json.loads(row["state"])):
                    if i >= len(job.tracks) or saved.get("status") not in TERMINAL:
                        continue
                    ts = job.tracks[i]
                    if saved["status"] == "completed" and not (saved.get("file") and (folder / saved["file"]).is_file()):
                        continue  # file was removed since; treat as not downloaded
                    ts.status, ts.file, ts.size = saved["status"], saved.get("file", ""), saved.get("size", 0)
                    ts.bitrate, ts.quality = saved.get("bitrate", 0), saved.get("quality", 0)
                    ts.note, ts.error = saved.get("note", ""), saved.get("error", "")
                    ts.progress = 1.0 if ts.status == "completed" else 0.0
            with self._lock:
                job = self.jobs.setdefault(job_id, job)
        if job.library_version != self.library.version:
            self._rematch(job)
        return job

    def _rematch(self, job: Job) -> None:
        with job.lock:
            job.library_version = self.library.version
            for ts, t in zip(job.tracks, job.playlist["tracks"]):
                if ts.status in ACTIVE or ts.status == "completed" or t.get("duplicate_of") is not None:
                    continue
                ts.match = self.library.match(t)
                if ts.status == "unavailable" and ts.match:
                    ts.status, ts.note = "idle", ""
                job.touch(ts)

    # ---------------------------------------------------------- control
    def start(self, job: Job, indexes: list[int] | None, quality: int) -> int:
        if quality not in QUALITIES:
            raise JobError("Unsupported audio quality.")
        music = self.music()
        with job.lock:
            if job.cancel.is_set() and job.outstanding > 0:
                raise JobError("Still cancelling the previous downloads. Try again in a moment.", 409)
            total = len(job.tracks)
            wanted = sorted(set(range(total) if indexes is None else indexes))
            if any(not isinstance(i, int) or i < 0 or i >= total for i in wanted):
                raise JobError("Unknown track index.")
            queue, need = [], 0
            for i in wanted:
                ts, t = job.tracks[i], job.playlist["tracks"][i]
                if t.get("duplicate_of") is not None or ts.status in ACTIVE:
                    continue
                if ts.status == "completed" and ts.quality == quality and (job.folder / ts.file).is_file():
                    continue  # already downloaded at this quality
                if ts.match is None:
                    job.set(ts, "unavailable", note="No matching file in your music library", error="", progress=0.0)
                    continue
                queue.append(i)
                need += ts.match["size"]
            if not queue:
                return 0
            if need > self.settings.max_job_gb * 1024 * MB:
                raise JobError(f"This selection exceeds the {self.settings.max_job_gb:g} GB job limit (MAX_JOB_GB).", 413)
            root = self.download_root()
            try:
                root.mkdir(parents=True, exist_ok=True)
                free = shutil.disk_usage(root).free
            except OSError:
                raise JobError("The download folder isn't accessible. Check it in Settings.")
            if free < need * 2 + 200 * MB:
                raise JobError("Not enough free disk space for this download.", 507)
            if job.outstanding == 0:  # a fresh batch
                job.batch, job.batch_started, job.bytes_done = set(), time.time(), 0
                job.samples.clear()
                job.cancel.clear()
                job.executor = ThreadPoolExecutor(max_workers=int(music["max_concurrent"]), thread_name_prefix="dl")
            job.started_at = job.started_at or time.time()
            job.quality = quality
            for i in queue:
                job.set(job.tracks[i], "pending", progress=0.0, error="", note="")
                job.batch.add(i)
                job.outstanding += 1
            assert job.executor is not None
            for i in queue:
                job.executor.submit(self._run_track, job, job.tracks[i], quality)
            return len(queue)

    def retry_failed(self, job: Job, quality: int) -> int:
        with job.lock:
            failed = [ts.index for ts in job.tracks if ts.status in ("failed", "cancelled")]
        return self.start(job, failed, quality) if failed else 0

    def cancel(self, job: Job) -> bool:
        with job.lock:
            if job.outstanding == 0:
                return False
            job.cancel.set()
            job.touch()
            return True

    def delete(self, job_id: str, remove_files: bool) -> None:
        job = self.get(job_id)
        if job is not None:
            with job.lock:
                if job.outstanding > 0:
                    raise JobError("Cancel the running download before deleting it.", 409)
            if remove_files and job.folder.is_dir() and job.folder.name.endswith(f"[{job_id[:6]}]"):
                shutil.rmtree(job.folder, ignore_errors=True)
        with self._lock:
            self.jobs.pop(job_id, None)
        self.db.execute("DELETE FROM history WHERE id=?", (job_id,))
        self.db.execute("DELETE FROM playlists WHERE id=?", (job_id,))

    # ---------------------------------------------------------- workers
    def _run_track(self, job: Job, ts: TrackState, quality: int) -> None:
        tmp = self.tmp_root / job.id
        try:
            self._process(job, ts, quality, tmp)
        except Cancelled:
            job.set(ts, "cancelled", progress=0.0, error="", note="")
        except AudioError as e:
            job.set(ts, "failed", progress=0.0, error=str(e))
        except Exception as e:  # never let one track take the worker down
            job.set(ts, "failed", progress=0.0, error=f"Unexpected error: {type(e).__name__}: {e}"[:300])
        finally:
            for leftover in tmp.glob(f"{ts.index}.*"):
                try:
                    leftover.unlink()
                except OSError:
                    pass
            with job.lock:
                job.outstanding -= 1
                done = job.outstanding == 0
            if done:
                self._finalize(job)

    def _process(self, job: Job, ts: TrackState, quality: int, tmp: Path) -> None:
        if job.cancel.is_set():
            raise Cancelled()
        t = job.playlist["tracks"][ts.index]
        music = self.music()

        job.set(ts, "searching", progress=0.0)
        match = self.library.match(t)
        if not match or not Path(match["path"]).is_file():
            job.set(ts, "unavailable", match=None, note="No matching file in your music library")
            return
        src = Path(match["path"])
        size = src.stat().st_size
        if size > self.settings.max_source_file_mb * MB:
            raise AudioError(f"Source file is larger than the {self.settings.max_source_file_mb} MB limit.")
        job.set(ts, "matched", match=match, progress=0.02)
        out = ensure_within(job.folder, job.folder / job.names[ts.index])
        kbps, passthrough = audio.plan_bitrate(match["codec"], match["bitrate"], match["lossless"], quality)
        if not passthrough and not self.ffmpeg:
            raise AudioError("FFmpeg isn't installed. Run setup.bat, or set FFMPEG_PATH in .env.")

        # --- download: stage the source into the temp area
        tmp.mkdir(parents=True, exist_ok=True)
        staged = tmp / f"{ts.index}.src{src.suffix.lower()}"
        job.set(ts, "downloading")
        copied, last = 0, 0.0
        with open(src, "rb") as fin, open(staged, "wb") as fout:
            while chunk := fin.read(256 * 1024):
                if job.cancel.is_set():
                    raise Cancelled()
                fout.write(chunk)
                copied += len(chunk)
                job.add_bytes(len(chunk))
                if time.time() - last > 0.1:
                    last = time.time()
                    job.set(ts, progress=0.02 + 0.28 * copied / max(size, 1))

        # --- convert
        part = tmp / f"{ts.index}.mp3.part"
        job.set(ts, "converting", progress=0.3)
        if passthrough:
            shutil.copyfile(staged, part)
            job.add_bytes(part.stat().st_size)
            note = f"Original MP3 kept as-is ({kbps} kbps)"
        else:
            seen = [0]

            def on_progress(fraction: float) -> None:
                try:
                    now_size = part.stat().st_size
                except OSError:
                    now_size = seen[0]
                job.add_bytes(max(0, now_size - seen[0]))
                seen[0] = now_size
                job.set(ts, progress=0.3 + 0.62 * fraction)

            audio.convert_to_mp3(self.ffmpeg, staged, part, kbps, match["duration"], on_progress, job.cancel)
            src_k = round(match["bitrate"] / 1000)
            note = (f"Source is {src_k} kbps {match['codec'].upper()}; encoded at {kbps} kbps, not upscaled"
                    if kbps < quality else "")
        if job.cancel.is_set():
            raise Cancelled()

        # --- tag, verify, publish
        job.set(ts, progress=0.94)
        art = None
        if music["include_artwork"]:
            art = audio.fetch_artwork(t.get("artwork_url")) or audio.extract_embedded_art(src)
        audio.tag_mp3(part, title=t["title"], artist=t["artist"], album=t.get("album") or match.get("album", ""),
                      track_no=ts.index + 1 if music["include_track_numbers"] else None, art=art)
        _, real_kbps = audio.verify_mp3(part)
        job.folder.mkdir(parents=True, exist_ok=True)
        os.replace(part, out)
        job.set(ts, "completed", progress=1.0, file=out.name, size=out.stat().st_size,
                bitrate=real_kbps, quality=quality, note=note, error="")

    def _finalize(self, job: Job) -> None:
        with job.lock:
            if job.executor is not None:
                job.executor.shutdown(wait=False)
                job.executor = None
            job.cancel.clear()
            job.touch()
        self.save_history(job)
        if self.music()["auto_cleanup"]:
            shutil.rmtree(self.tmp_root / job.id, ignore_errors=True)

    # ---------------------------------------------------------- views
    def save_history(self, job: Job) -> None:
        with job.lock:
            state = [{"status": ts.status, "file": ts.file, "size": ts.size, "bitrate": ts.bitrate,
                      "quality": ts.quality, "note": ts.note, "error": ts.error} for ts in job.tracks]
            completed = sum(1 for ts in job.tracks if ts.status == "completed")
            failed = sum(1 for ts in job.tracks if ts.status == "failed")
            size = sum(ts.size for ts in job.tracks if ts.status == "completed")
            p = job.playlist
            self.db.execute(
                "INSERT INTO history(id,name,cover_url,source,started_at,updated_at,total,completed,failed,bytes,quality,folder,state)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,"
                " total=excluded.total, completed=excluded.completed, failed=excluded.failed, bytes=excluded.bytes,"
                " quality=excluded.quality, folder=excluded.folder, state=excluded.state",
                (job.id, p["name"], p.get("cover_url"), p.get("source", ""), job.started_at or time.time(), time.time(),
                 len(job.tracks), completed, failed, size, job.quality, str(job.folder), json.dumps(state)))

    def estimates(self, job: Job) -> dict[str, int]:
        out = {}
        for q in QUALITIES:
            total = 0.0
            for ts, t in zip(job.tracks, job.playlist["tracks"]):
                if ts.match and t.get("duplicate_of") is None:
                    kbps, _ = audio.plan_bitrate(ts.match["codec"], ts.match["bitrate"], ts.match["lossless"], q)
                    seconds = ts.match["duration"] or t["duration_ms"] / 1000
                    total += seconds * kbps * 1000 / 8
            out[str(q)] = int(total)
        return out

    def snapshot(self, job: Job, since: int = 0) -> dict:
        with job.lock:
            pl = job.playlist["tracks"]
            running = job.outstanding > 0
            counts = {"completed": 0, "failed": 0, "unavailable": 0, "cancelled": 0, "duplicates": 0, "available": 0}
            for ts, t in zip(job.tracks, pl):
                if t.get("duplicate_of") is not None:
                    counts["duplicates"] += 1
                    continue
                if ts.status in ("completed", "failed", "cancelled"):
                    counts[ts.status] += 1
                if ts.match or ts.status == "completed":
                    counts["available"] += 1
                else:
                    counts["unavailable"] += 1
            batch = [job.tracks[i] for i in sorted(job.batch)]
            done = sum(1 for ts in batch if ts.status in TERMINAL)
            fraction = (sum(1.0 if ts.status in TERMINAL else ts.progress for ts in batch) / len(batch)) if batch else 0.0
            elapsed = time.time() - job.batch_started if running else 0.0
            eta = elapsed * (1 - fraction) / fraction if running and 0.03 < fraction < 1 and elapsed > 1 else None
            current = next((ts for ts in batch if ts.status in ("downloading", "converting")), None) or next(
                (ts for ts in batch if ts.status in ("searching", "matched")), None)
            tracks = [
                {"index": ts.index, "status": ts.status, "progress": round(ts.progress, 4), "error": ts.error,
                 "note": ts.note, "size": ts.size, "bitrate": ts.bitrate, "file": ts.file,
                 "available": bool(ts.match) or ts.status == "completed",
                 "score": ts.match["score"] if ts.match else None,
                 "source": ({"codec": ts.match["codec"], "kbps": round(ts.match["bitrate"] / 1000),
                             "lossless": ts.match["lossless"]} if ts.match else None)}
                for ts in job.tracks if ts.v > since or since == 0
            ]
            return {
                "id": job.id, "version": job.version, "running": running,
                "cancelling": running and job.cancel.is_set(), "quality": job.quality,
                "summary": {
                    **counts, "total": len(job.tracks), "batch_total": len(batch), "batch_done": done,
                    "remaining": len(batch) - done, "percent": round(fraction * 100, 1),
                    "speed_bps": round(job.speed()) if running else 0, "eta_seconds": round(eta) if eta is not None else None,
                    "bytes_total": sum(ts.size for ts in job.tracks if ts.status == "completed"),
                    "current": ({"index": current.index, "title": pl[current.index]["title"],
                                 "artist": pl[current.index]["artist"], "status": current.status} if current else None),
                },
                "tracks": tracks,
            }

    # ---------------------------------------------------------- deliverables
    def completed_file(self, job: Job, index: int) -> Path | None:
        if not 0 <= index < len(job.tracks):
            return None
        ts = job.tracks[index]
        if ts.status != "completed" or not ts.file:
            return None
        try:
            path = ensure_within(job.folder, job.folder / ts.file)
        except ValueError:
            return None
        return path if path.is_file() and path.stat().st_size > 0 else None

    def zip_name(self, job: Job) -> str:
        return safe_filename(job.playlist["name"], "Playlist", 100) + ".zip"

    def zip_entries(self, job: Job) -> list[tuple[str, Path | bytes]]:
        """Completed, verified MP3s plus Playlist.m3u, Playlist.csv and Download-report.txt."""
        pl = job.playlist
        entries: list[tuple[str, Path | bytes]] = []
        m3u = ["#EXTM3U"]
        table = io.StringIO()
        writer = csv.writer(table)
        writer.writerow(["Track", "Title", "Artist", "Album", "Duration (s)", "Status", "File", "Bitrate (kbps)", "Note"])
        lines = []
        ok = 0
        with job.lock:
            for ts, t in zip(job.tracks, pl["tracks"]):
                path = self.completed_file(job, ts.index)
                status = "duplicate" if t.get("duplicate_of") is not None else (
                    ts.status if ts.status != "idle" else ("not downloaded" if ts.match else "unavailable"))
                if ts.status == "completed" and path is None:
                    status = "missing"
                if path is not None:
                    ok += 1
                    entries.append((path.name, path))
                    m3u += [f"#EXTINF:{round(t['duration_ms'] / 1000)},{t['artist']} - {t['title']}", path.name]
                detail = ts.error or ts.note
                writer.writerow([ts.index + 1, t["title"], t["artist"], t.get("album", ""), round(t["duration_ms"] / 1000),
                                 status, path.name if path else "", ts.bitrate or "", detail])
                lines.append(f"{ts.index + 1:>4}. [{status.upper():<14}] {t['artist']} - {t['title']}"
                             + (f"  ({detail})" if detail else ""))
        if not ok:
            raise JobError("There are no completed songs to put in a ZIP yet.", 409)
        report = [
            "Glyph Music - download report", "=" * 30, f"Playlist : {pl['name']}",
            f"Source   : {pl.get('source_url') or 'CSV import'}", f"Created  : {datetime.now():%Y-%m-%d %H:%M}",
            f"Quality  : up to {job.quality} kbps MP3 (sources are never upscaled)",
            f"Included : {ok} of {len(job.tracks)} songs", "", "Audio source: your local music library.", "", *lines, "",
        ]
        entries.append(("Playlist.m3u", ("\n".join(m3u) + "\n").encode("utf-8")))
        entries.append(("Playlist.csv", ("﻿" + table.getvalue()).encode("utf-8")))
        entries.append(("Download-report.txt", "\n".join(report).encode("utf-8")))
        return entries
