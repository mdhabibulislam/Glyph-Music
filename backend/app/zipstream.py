"""Streaming ZIP writer: yields the archive in chunks, never holding it in memory."""
from __future__ import annotations

import time
import zipfile
from pathlib import Path
from typing import Iterable, Iterator

CHUNK = 1024 * 1024


class _Sink:
    """Write-only, non-seekable buffer, which makes ZipFile emit a streamable archive."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []
        self._pos = 0

    def write(self, data) -> int:
        self._chunks.append(bytes(data))
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks.clear()
        return data


def stream_zip(entries: Iterable[tuple[str, Path | bytes]]) -> Iterator[bytes]:
    """entries: (archive name, file path or in-memory bytes). MP3s are stored, not recompressed."""
    sink = _Sink()
    now = time.localtime()[:6]
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for name, source in entries:
            info = zipfile.ZipInfo(name, date_time=now)
            info.external_attr = 0o644 << 16
            with zf.open(info, "w", force_zip64=True) as dest:
                if isinstance(source, bytes):
                    dest.write(source)
                else:
                    with open(source, "rb") as f:
                        while chunk := f.read(CHUNK):
                            dest.write(chunk)
                            data = sink.take()
                            if data:
                                yield data
            data = sink.take()
            if data:
                yield data
    tail = sink.take()
    if tail:
        yield tail
