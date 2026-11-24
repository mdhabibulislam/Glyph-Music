"use client";

// Vercel-only mode. There is no PC backend: the site reads the track list, looks each
// song up among openly licensed recordings on the Internet Archive, and the browser
// downloads the files directly and builds the ZIP itself. Progress is measured from
// the bytes that actually arrive.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type HistoryItem, type JobSnapshot, type MusicSettings, type Playlist, type PlaylistPayload, type TrackState } from "./api";
import { importCsvText } from "./csv";
import { MusicContext, type MusicCtx, type MusicError } from "./music";
import { safeFilename, type OpenMatch } from "./open";
import { buildZip, crc32, type ZipEntry } from "./zip";

const HISTORY_KEY = "glyph.cloud.history.v1";
const SETTINGS_KEY = "glyph.cloud.settings.v1";
const MAX_HISTORY = 12;
const MAX_BATCH_BYTES = 1500 * 1024 * 1024; // files are held by the browser until saved
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const NOT_FOUND = "Not in the free-music collections";

type Matches = Record<number, OpenMatch | null>;
interface Stored {
  item: HistoryItem;
  playlist: Playlist;
  matches: Matches;
}
interface Run {
  controller: AbortController;
  queue: number[];
  active: number;
  started: number;
  bytes: number;
  samples: [number, number][];
  single: number | null;
  completedAtStart: number;
}

const BASE_SETTINGS: MusicSettings = {
  default_quality: 320, max_concurrent: 3, download_folder: "", download_folder_effective: "",
  library_folders: [], auto_zip: true, include_artwork: true, include_track_numbers: true, auto_cleanup: true,
  library: { tracks: 1, running: false, scanned: 0, found: 0, error: "", finished_at: 0 },
  ffmpeg: true, qualities: [], limits: { max_playlist_tracks: 1000, max_job_gb: 1.5, max_source_file_mb: 400 },
};

function readStore<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileNames(playlist: Playlist): Record<number, string> {
  const names: Record<number, string> = {};
  const used = new Set<string>();
  for (const t of playlist.tracks) {
    if (t.duplicate_of !== null) continue;
    const base = safeFilename(`${t.artist || "Unknown Artist"} - ${t.title}`, "untitled", 140);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    names[t.index] = `${name}.mp3`;
  }
  return names;
}

export function CloudMusicProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<PlaylistPayload | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [states, setStates] = useState<Record<number, TrackState>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MusicError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<MusicSettings>(BASE_SETTINGS);

  const playlist = useRef<Playlist | null>(null);
  const names = useRef<Record<number, string>>({});
  const matches = useRef<Matches>({});
  const track = useRef<Record<number, TrackState>>({});
  const blobs = useRef(new Map<number, { blob: Blob; crc: number }>());
  const batch = useRef(new Set<number>());
  const run = useRef<Run | null>(null);
  const settingsRef = useRef(settings);
  const version = useRef(1);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    const saved = readStore<Partial<MusicSettings>>(SETTINGS_KEY, {});
    const next = {
      ...BASE_SETTINGS,
      max_concurrent: Math.min(6, Math.max(1, Number(saved.max_concurrent) || BASE_SETTINGS.max_concurrent)),
      auto_zip: typeof saved.auto_zip === "boolean" ? saved.auto_zip : true,
    };
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return;
    setError({
      message: e instanceof Error ? e.message : "Something went wrong.",
      csvFallback: e instanceof ApiError && e.data.fallback === "csv",
    });
  };

  // ------------------------------------------------------------------ snapshot
  const snapshot = useCallback((): JobSnapshot | null => {
    const pl = playlist.current;
    if (!pl) return null;
    const st = track.current;
    const r = run.current;
    const counts = { completed: 0, failed: 0, unavailable: 0, cancelled: 0, duplicates: 0, available: 0 };
    let bytesTotal = 0;
    for (const t of pl.tracks) {
      const s = st[t.index];
      if (t.duplicate_of !== null) {
        counts.duplicates++;
        continue;
      }
      if (s.status === "completed") {
        counts.completed++;
        bytesTotal += s.size;
      } else if (s.status === "failed") counts.failed++;
      else if (s.status === "cancelled") counts.cancelled++;
      if (s.available) counts.available++;
      else if (s.status !== "searching") counts.unavailable++;
    }
    const list = [...batch.current].sort((a, b) => a - b).map((i) => st[i]);
    const terminal = (s: TrackState) => ["completed", "failed", "cancelled", "unavailable"].includes(s.status);
    const done = list.filter(terminal).length;
    const fraction = list.length ? list.reduce((n, s) => n + (terminal(s) ? 1 : s.progress), 0) / list.length : 0;
    const now = Date.now();
    const elapsed = r ? (now - r.started) / 1000 : 0;
    const recent = r ? r.samples.filter(([t]) => now - t <= 3000) : [];
    const speed = recent.length > 1 && recent[recent.length - 1][0] > recent[0][0]
      ? ((recent[recent.length - 1][1] - recent[0][1]) * 1000) / (recent[recent.length - 1][0] - recent[0][0]) : 0;
    const current = list.find((s) => s.status === "downloading");
    return {
      id: pl.id,
      version: ++version.current,
      running: !!r,
      cancelling: !!r && r.controller.signal.aborted,
      quality: 320,
      summary: {
        ...counts,
        total: pl.tracks.length,
        batch_total: list.length,
        batch_done: done,
        remaining: list.length - done,
        percent: Math.round(fraction * 1000) / 10,
        speed_bps: Math.round(speed),
        eta_seconds: r && fraction > 0.03 && fraction < 1 && elapsed > 1 ? Math.round((elapsed * (1 - fraction)) / fraction) : null,
        bytes_total: bytesTotal,
        current: current ? { index: current.index, title: pl.tracks[current.index].title, artist: pl.tracks[current.index].artist, status: current.status } : null,
      },
      tracks: pl.tracks.map((t) => st[t.index]),
    };
  }, []);

  const publish = useCallback(() => {
    timer.current = null;
    const snap = snapshot();
    setJob(snap);
    setStates({ ...track.current });
  }, [snapshot]);

  /** Coalesce bursts of progress updates into one render. */
  const publishSoon = useCallback(() => {
    if (timer.current === null) timer.current = window.setTimeout(publish, 120);
  }, [publish]);

  const patch = useCallback((index: number, fields: Partial<TrackState>) => {
    track.current[index] = { ...track.current[index], ...fields };
    publishSoon();
  }, [publishSoon]);

  const estimates = () => {
    let total = 0;
    for (const t of playlist.current?.tracks ?? []) if (t.duplicate_of === null) total += matches.current[t.index]?.size ?? 0;
    return { "320": total };
  };

  // ------------------------------------------------------------------ history (this browser only)
  const saveHistory = useCallback(() => {
    const pl = playlist.current;
    if (!pl) return;
    const st = Object.values(track.current);
    const done = st.filter((s) => s.status === "completed");
    const item: HistoryItem = {
      id: pl.id, name: pl.name, cover_url: pl.cover_url, source: pl.source,
      started_at: (startedAt.current || Date.now()) / 1000, updated_at: Date.now() / 1000,
      total: pl.tracks.length, completed: done.length, failed: st.filter((s) => s.status === "failed").length,
      bytes: done.reduce((n, s) => n + s.size, 0), quality: 0, folder: "",
    };
    const list = readStore<Stored[]>(HISTORY_KEY, []).filter((h) => h.item.id !== pl.id);
    list.unshift({ item, playlist: pl, matches: matches.current });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
    } catch {
      /* storage full: history is a convenience, not essential */
    }
  }, []);

  // ------------------------------------------------------------------ opening a playlist
  const matchedState = (index: number, m: OpenMatch | null): Partial<TrackState> =>
    m ? {
      status: "idle", available: true, score: m.score, size: 0, note: `${m.licenceName} · ${m.creator || m.itemTitle}`,
      source: { codec: "mp3", kbps: m.kbps, lossless: false },
    } : { status: "unavailable", available: false, note: NOT_FOUND };

  const search = useCallback(async (pl: Playlist) => {
    const todo = pl.tracks.filter((t) => t.duplicate_of === null);
    const chunks: (typeof todo)[] = [];
    for (let i = 0; i < todo.length; i += 4) chunks.push(todo.slice(i, i + 4));
    const worker = async () => {
      for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
        if (playlist.current?.id !== pl.id) return; // a different playlist was opened meanwhile
        let results: { index: number; match: OpenMatch | null; error: boolean }[];
        try {
          const body = { tracks: chunk.map((t) => ({ index: t.index, title: t.title, artist: t.artist, artists: t.artists, duration_ms: t.duration_ms })) };
          results = (await api<{ results: typeof results }>("/playlist/match", { method: "POST", body })).results;
        } catch {
          results = chunk.map((t) => ({ index: t.index, match: null, error: true }));
        }
        if (playlist.current?.id !== pl.id) return;
        const found: number[] = [];
        for (const r of results) {
          if (!(r.index in track.current)) continue;
          matches.current[r.index] = r.match;
          patch(r.index, r.error ? { status: "unavailable", available: false, note: "The search couldn't be completed. Fetch again to retry." } : matchedState(r.index, r.match));
          if (r.match) found.push(r.index);
        }
        if (found.length) setSelected((s) => new Set([...s, ...found]));
        setPayload((p) => (p && p.playlist.id === pl.id ? { ...p, estimates: estimates() } : p));
      }
    };
    await Promise.all([worker(), worker()]);
    if (playlist.current?.id === pl.id) saveHistory();
  }, [patch, saveHistory]);

  const open = useCallback((pl: Playlist, known?: Matches) => {
    run.current?.controller.abort();
    run.current = null;
    playlist.current = pl;
    names.current = fileNames(pl);
    matches.current = known ? { ...known } : {};
    blobs.current = new Map();
    batch.current = new Set();
    startedAt.current = Date.now();
    const st: Record<number, TrackState> = {};
    const picked: number[] = [];
    for (const t of pl.tracks) {
      const base: TrackState = { index: t.index, status: "idle", progress: 0, error: "", note: "", size: 0, bitrate: 0, file: "", available: false, score: null, source: null };
      if (t.duplicate_of !== null) st[t.index] = base;
      else if (known) {
        st[t.index] = { ...base, ...matchedState(t.index, known[t.index] ?? null) };
        if (known[t.index]) picked.push(t.index);
      } else st[t.index] = { ...base, status: "searching", note: "Searching the free-music collections" };
    }
    track.current = st;
    setSelected(new Set(picked));
    setPayload({ playlist: pl, job: snapshot()!, estimates: estimates(), folder: "", library_count: 1 });
    publish();
    if (!known) void search(pl);
  }, [publish, search, snapshot]);

  // ------------------------------------------------------------------ downloading
  const downloadZip = useCallback(async () => {
    const pl = playlist.current;
    if (!pl) return;
    const entries: ZipEntry[] = [];
    const m3u = ["#EXTM3U"];
    const csv = ["Track,Title,Artist,Status,File,Licence,Source"];
    const lines: string[] = [];
    const q = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    for (const t of pl.tracks) {
      const s = track.current[t.index];
      const m = matches.current[t.index];
      const held = blobs.current.get(t.index);
      const status = t.duplicate_of !== null ? "duplicate" : s.status === "idle" ? "not downloaded" : s.status;
      const page = m ? `https://archive.org/details/${m.item}` : "";
      if (s.status === "completed" && held) {
        entries.push({ name: s.file, data: held.blob, crc: held.crc });
        m3u.push(`#EXTINF:${Math.round(t.duration_ms / 1000)},${t.artist} - ${t.title}`, s.file);
      }
      csv.push([t.index + 1, t.title, t.artist, status, held && s.status === "completed" ? s.file : "", m?.licenceName ?? "", page].map(q).join(","));
      lines.push(`${String(t.index + 1).padStart(4)}. [${status.toUpperCase().padEnd(14)}] ${t.artist} - ${t.title}` +
        (m && s.status === "completed" ? `\n        ${m.licenceName} | by ${m.creator || "unknown"} | ${page}` : ""));
    }
    if (!entries.length) {
      setNotice("There are no finished songs to put in a ZIP yet. Download them first.");
      return;
    }
    const report = [
      "Glyph Music - download report", "==============================", `Playlist : ${pl.name}`,
      `Source   : ${pl.source_url || "CSV import"}`, `Created  : ${new Date().toLocaleString()}`,
      `Included : ${entries.length} of ${pl.tracks.length} songs`, "",
      "Audio source: openly licensed recordings from the Internet Archive (archive.org).",
      "Each file keeps the licence shown beside it. Creative Commons licences ask you to",
      "credit the artist, and some do not allow commercial use or changes.", "", ...lines, "",
    ];
    const text = (s: string) => new Blob([s], { type: "text/plain" });
    entries.push({ name: "Playlist.m3u", data: text(m3u.join("\n") + "\n") });
    entries.push({ name: "Playlist.csv", data: text("﻿" + csv.join("\n") + "\n") });
    entries.push({ name: "Download-report.txt", data: text(report.join("\n")) });
    try {
      saveBlob(await buildZip(entries), `${safeFilename(pl.name, "Playlist", 100)}.zip`);
    } catch (e) {
      fail(e);
    }
  }, []);

  const finish = useCallback(() => {
    const r = run.current;
    run.current = null;
    publish();
    saveHistory();
    if (!r) return;
    if (r.single !== null) {
      const s = track.current[r.single];
      const held = blobs.current.get(r.single);
      if (s?.status === "completed" && held) saveBlob(held.blob, s.file);
    } else if (settingsRef.current.auto_zip) {
      const done = Object.values(track.current).filter((s) => s.status === "completed").length;
      if (done > r.completedAtStart) void downloadZip();
    }
  }, [publish, saveHistory, downloadZip]);

  const downloadOne = useCallback(async (index: number, r: Run) => {
    const m = matches.current[index];
    if (!m) return patch(index, { status: "unavailable", note: NOT_FOUND });
    patch(index, { status: "downloading", progress: 0, error: "" });
    try {
      const res = await fetch(m.url, { signal: r.controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`The source answered with HTTP ${res.status}.`);
      const total = Number(res.headers.get("content-length")) || m.size;
      if (total > MAX_FILE_BYTES) throw new Error("This file is larger than the 400 MB limit.");
      const reader = res.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;
      let crc = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as unknown as BlobPart);
        received += value.length;
        crc = crc32(value, crc);
        if (received > MAX_FILE_BYTES) throw new Error("This file is larger than the 400 MB limit.");
        r.bytes += value.length;
        const now = Date.now();
        if (!r.samples.length || now - r.samples[r.samples.length - 1][0] >= 200) {
          r.samples.push([now, r.bytes]);
          if (r.samples.length > 60) r.samples.shift();
        }
        patch(index, { progress: total ? Math.min(0.99, received / total) : 0 });
      }
      if (received < 1024) throw new Error("The file arrived incomplete.");
      blobs.current.set(index, { blob: new Blob(chunks, { type: "audio/mpeg" }), crc });
      patch(index, { status: "completed", progress: 1, size: received, bitrate: m.kbps, file: names.current[index] });
    } catch (e) {
      if (r.controller.signal.aborted) patch(index, { status: "cancelled", progress: 0, error: "" });
      else patch(index, { status: "failed", progress: 0, error: e instanceof TypeError ? "The download was interrupted. Check your connection and retry." : e instanceof Error ? e.message : "Download failed." });
    }
  }, [patch]);

  const pump = useCallback(() => {
    const r = run.current;
    if (!r) return;
    while (r.active < settingsRef.current.max_concurrent && r.queue.length) {
      const index = r.queue.shift()!;
      if (r.controller.signal.aborted) {
        patch(index, { status: "cancelled", progress: 0 });
        continue;
      }
      r.active++;
      void downloadOne(index, r).finally(() => {
        r.active--;
        if (run.current !== r) return;
        if (!r.queue.length && r.active === 0) finish();
        else pump();
      });
    }
    if (!r.queue.length && r.active === 0 && run.current === r) finish();
  }, [downloadOne, finish, patch]);

  const begin = useCallback(async (indexes: number[] | null, single: number | null) => {
    const pl = playlist.current;
    if (!pl) return;
    setError(null);
    setNotice(null);
    if (run.current?.controller.signal.aborted) return setNotice("Still cancelling the previous downloads. Try again in a moment.");
    const wanted = (indexes ?? pl.tracks.map((t) => t.index)).filter((i) => {
      const s = track.current[i];
      const busy = ["pending", "downloading"].includes(s?.status);
      const have = s?.status === "completed" && blobs.current.has(i);
      return s && pl.tracks[i].duplicate_of === null && !!matches.current[i] && !busy && !have;
    });
    if (!wanted.length) {
      const held = single !== null ? blobs.current.get(single) : undefined;
      if (single !== null && held) saveBlob(held.blob, track.current[single].file);
      else setNotice("Nothing new to download - those songs are already finished or unavailable.");
      return;
    }
    const held = [...blobs.current.values()].reduce((n, b) => n + b.blob.size, 0);
    const size = wanted.reduce((n, i) => n + (matches.current[i]?.size ?? 0), 0);
    if (held + size > MAX_BATCH_BYTES) {
      return setNotice("That is more than 1.5 GB for one browser session. Select fewer songs, download them, then do the rest.");
    }
    if (!run.current) {
      batch.current = new Set();
      run.current = {
        controller: new AbortController(), queue: [], active: 0, started: Date.now(), bytes: 0, samples: [], single,
        completedAtStart: Object.values(track.current).filter((s) => s.status === "completed").length,
      };
    }
    for (const i of wanted) {
      patch(i, { status: "pending", progress: 0, error: "" });
      batch.current.add(i);
      run.current.queue.push(i);
    }
    publish();
    pump();
  }, [patch, publish, pump]);

  // ------------------------------------------------------------------ context value
  const value = useMemo<MusicCtx>(() => ({
    mode: "cloud",
    payload, job, states, selected, quality: 320, loading, error, notice, settings,
    setQuality: () => {},
    toggle: (index) => setSelected((s) => {
      const n = new Set(s);
      if (n.has(index)) n.delete(index);
      else n.add(index);
      return n;
    }),
    selectAll: (indexes) => setSelected((s) => new Set([...s, ...indexes])),
    deselectAll: () => setSelected(new Set()),
    fetchPlaylist: async (url) => {
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        open((await api<{ playlist: Playlist }>("/playlist/fetch", { method: "POST", body: { url } })).playlist);
      } catch (e) {
        fail(e);
      }
      setLoading(false);
    },
    importCsv: async (name, csv) => {
      setError(null);
      setNotice(null);
      try {
        open(importCsvText(csv, name));
      } catch (e) {
        fail(e);
      }
    },
    loadJob: async (id) => {
      const stored = readStore<Stored[]>(HISTORY_KEY, []).find((h) => h.item.id === id);
      if (!stored) {
        setError({ message: "That playlist is no longer saved in this browser." });
        return false;
      }
      setError(null);
      open(stored.playlist, stored.matches);
      return true;
    },
    clear: () => {
      run.current?.controller.abort();
      run.current = null;
      playlist.current = null;
      blobs.current = new Map();
      track.current = {};
      setPayload(null);
      setJob(null);
      setStates({});
      setSelected(new Set());
      setError(null);
      setNotice(null);
    },
    start: (indexes) => begin(indexes, null),
    downloadTrack: async (index) => {
      const held = blobs.current.get(index);
      if (track.current[index]?.status === "completed" && held) saveBlob(held.blob, track.current[index].file);
      else await begin([index], index);
    },
    cancel: async () => {
      const r = run.current;
      if (!r) return;
      r.single = null;
      r.controller.abort();
      for (const i of r.queue.splice(0)) patch(i, { status: "cancelled", progress: 0 });
      publish();
      if (r.active === 0) finish();
    },
    retry: async () => {
      const again = Object.values(track.current).filter((s) => s.status === "failed" || s.status === "cancelled").map((s) => s.index);
      if (again.length) await begin(again, null);
      else setNotice("There are no failed songs to retry.");
    },
    downloadZip: () => downloadZip(),
    refreshSettings: async () => {},
    saveSettings: async (change) => {
      const next = {
        ...settingsRef.current,
        ...(typeof change.max_concurrent === "number" ? { max_concurrent: Math.min(6, Math.max(1, change.max_concurrent)) } : {}),
        ...(typeof change.auto_zip === "boolean" ? { auto_zip: change.auto_zip } : {}),
      };
      settingsRef.current = next;
      setSettings(next);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ max_concurrent: next.max_concurrent, auto_zip: next.auto_zip }));
      return true;
    },
    dismiss: () => {
      setError(null);
      setNotice(null);
    },
    historyList: async () => readStore<Stored[]>(HISTORY_KEY, []).map((h) => h.item),
    historyRemove: async (id) => {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(readStore<Stored[]>(HISTORY_KEY, []).filter((h) => h.item.id !== id)));
    },
  }), [payload, job, states, selected, loading, error, notice, settings, open, begin, patch, publish, finish, downloadZip]);

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}
