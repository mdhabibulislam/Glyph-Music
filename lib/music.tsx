"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api, ApiError, triggerDownload,
  type HistoryItem, type JobSnapshot, type MusicSettings, type PlaylistPayload, type TrackState,
} from "./api";

export interface MusicError {
  message: string;
  /** True when Spotify couldn't be read and CSV import is the way forward. */
  csvFallback?: boolean;
}

export interface MusicCtx {
  /** "local": the Python backend on your PC and your own library. "cloud": the site
   *  alone (Vercel), finding openly licensed music and downloading it in the browser. */
  mode: "local" | "cloud";
  historyList: () => Promise<HistoryItem[]>;
  historyRemove: (id: string, withFiles: boolean) => Promise<void>;
  payload: PlaylistPayload | null;
  job: JobSnapshot | null;
  states: Record<number, TrackState>;
  selected: Set<number>;
  quality: number;
  loading: boolean;
  error: MusicError | null;
  notice: string | null;
  settings: MusicSettings | null;
  setQuality: (q: number) => void;
  toggle: (index: number) => void;
  selectAll: (indexes: number[]) => void;
  deselectAll: () => void;
  fetchPlaylist: (url: string) => Promise<void>;
  importCsv: (name: string, csv: string) => Promise<void>;
  loadJob: (id: string) => Promise<boolean>;
  clear: () => void;
  start: (indexes: number[] | null) => Promise<void>;
  downloadTrack: (index: number) => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  downloadZip: (jobId?: string) => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: Partial<MusicSettings>) => Promise<boolean>;
  dismiss: () => void;
}

type Ctx = MusicCtx;

export const MusicContext = createContext<MusicCtx | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<PlaylistPayload | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [states, setStates] = useState<Record<number, TrackState>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [quality, setQualityState] = useState(320);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MusicError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<MusicSettings | null>(null);

  const qualityTouched = useRef(false);
  const settingsRef = useRef<MusicSettings | null>(null);
  const statesRef = useRef<Record<number, TrackState>>({});
  const wasRunning = useRef(false);
  const completedAtStart = useRef(0);
  const single = useRef<number | null>(null);
  const lastEvent = useRef(0);
  const jobId = payload?.playlist.id ?? null;

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return;
    setError({
      message: e instanceof Error ? e.message : "Something went wrong.",
      csvFallback: e instanceof ApiError && e.data.fallback === "csv",
    });
  };

  const downloadZip = useCallback(async (id?: string) => {
    const target = id ?? jobId;
    if (!target) return;
    try {
      const link = await api<{ url: string }>(`/jobs/${target}/zip-link`);
      triggerDownload(link.url);
    } catch (e) {
      fail(e);
    }
  }, [jobId]);

  /** Merge a snapshot (full or partial) from SSE, polling or an action response. */
  const apply = useCallback((snap: JobSnapshot, full = false) => {
    lastEvent.current = Date.now();
    const next = full ? {} : { ...statesRef.current };
    for (const t of snap.tracks) next[t.index] = t;
    statesRef.current = next;
    setStates(next);
    setJob(snap);

    if (wasRunning.current && !snap.running) {
      // The batch just finished: hand over the result automatically.
      const one = single.current;
      single.current = null;
      if (one !== null) {
        if (next[one]?.status === "completed") triggerDownload(`/api/jobs/${snap.id}/tracks/${one}/file`);
      } else if (settingsRef.current?.auto_zip && snap.summary.completed > completedAtStart.current) {
        api<{ url: string }>(`/jobs/${snap.id}/zip-link`).then((l) => triggerDownload(l.url)).catch(() => {});
      }
    }
    wasRunning.current = snap.running;
  }, []);

  const open = useCallback((p: PlaylistPayload) => {
    wasRunning.current = p.job.running;
    single.current = null;
    setPayload(p);
    apply(p.job, true);
    // Start with everything that can actually be downloaded selected.
    setSelected(new Set(p.job.tracks.filter((t) => t.available && p.playlist.tracks[t.index].duplicate_of === null).map((t) => t.index)));
  }, [apply]);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await api<MusicSettings>("/settings");
      settingsRef.current = s;
      setSettings(s);
      if (!qualityTouched.current) setQualityState(s.default_quality);
    } catch {
      /* surfaced by the page that needs it */
    }
  }, []);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  // Live progress: Server-Sent Events, with polling as a safety net if a proxy buffers the stream.
  useEffect(() => {
    if (!jobId) return;
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (ev) => {
      try {
        apply(JSON.parse(ev.data) as JobSnapshot);
      } catch {
        /* ignore malformed frames */
      }
    };
    const poll = window.setInterval(async () => {
      if (!wasRunning.current || Date.now() - lastEvent.current < 2500) return;
      try {
        const p = await api<PlaylistPayload>(`/jobs/${jobId}`);
        apply(p.job, true);
      } catch {
        /* keep trying */
      }
    }, 1500);
    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, [jobId, apply]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
  }, []);

  const fetchPlaylist = useCallback(async (url: string) => {
    setLoading(true);
    await run(async () => open(await api<PlaylistPayload>("/playlist/fetch", { method: "POST", body: { url } })));
    setLoading(false);
  }, [run, open]);

  const importCsv = useCallback(async (name: string, csv: string) => {
    setLoading(true);
    await run(async () => open(await api<PlaylistPayload>("/playlist/import-csv", { method: "POST", body: { name, csv } })));
    setLoading(false);
  }, [run, open]);

  const loadJob = useCallback(async (id: string) => {
    setLoading(true);
    let ok = false;
    await run(async () => {
      open(await api<PlaylistPayload>(`/jobs/${id}`));
      ok = true;
    });
    setLoading(false);
    return ok;
  }, [run, open]);

  const begin = useCallback(async (indexes: number[] | null, one: number | null) => {
    if (!jobId) return;
    await run(async () => {
      completedAtStart.current = Object.values(statesRef.current).filter((t) => t.status === "completed").length;
      const res = await api<{ queued: number; job: JobSnapshot }>(`/jobs/${jobId}/start`, {
        method: "POST", body: { indexes, quality },
      });
      if (res.queued > 0 && !wasRunning.current) single.current = one;
      wasRunning.current = wasRunning.current || res.job.running;
      apply(res.job, true);
      if (res.queued === 0) {
        if (one !== null && res.job.tracks[one]?.status === "completed") triggerDownload(`/api/jobs/${jobId}/tracks/${one}/file`);
        else setNotice("Nothing new to download - those songs are already finished or unavailable.");
      }
    });
  }, [jobId, quality, run, apply]);

  const start = useCallback((indexes: number[] | null) => begin(indexes, null), [begin]);

  const downloadTrack = useCallback(async (index: number) => {
    const st = statesRef.current[index];
    if (st?.status === "completed" && jobId) triggerDownload(`/api/jobs/${jobId}/tracks/${index}/file`);
    else await begin([index], index);
  }, [begin, jobId]);

  const cancel = useCallback(async () => {
    if (!jobId) return;
    await run(async () => {
      single.current = null;
      const res = await api<{ job: JobSnapshot }>(`/jobs/${jobId}/cancel`, { method: "POST" });
      apply(res.job, true);
    });
  }, [jobId, run, apply]);

  const retry = useCallback(async () => {
    if (!jobId) return;
    await run(async () => {
      completedAtStart.current = Object.values(statesRef.current).filter((t) => t.status === "completed").length;
      const res = await api<{ queued: number; job: JobSnapshot }>(`/jobs/${jobId}/retry`, { method: "POST", body: { quality } });
      wasRunning.current = wasRunning.current || res.job.running;
      apply(res.job, true);
      if (!res.queued) setNotice("There are no failed songs to retry.");
    });
  }, [jobId, quality, run, apply]);

  const saveSettings = useCallback(async (patch: Partial<MusicSettings>) => {
    try {
      const s = await api<MusicSettings>("/settings", { method: "PUT", body: patch });
      settingsRef.current = s;
      setSettings(s);
      if (patch.default_quality) {
        qualityTouched.current = false;
        setQualityState(s.default_quality);
      }
      setError(null);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }, []);

  const value = useMemo<Ctx>(() => ({
    mode: "local",
    historyList: async () => (await api<{ items: HistoryItem[] }>("/history")).items,
    historyRemove: async (id, withFiles) => {
      await api(`/history/${id}?files=${withFiles}`, { method: "DELETE" });
    },
    payload, job, states, selected, quality, loading, error, notice, settings,
    setQuality: (q) => {
      qualityTouched.current = true;
      setQualityState(q);
    },
    toggle: (index) => setSelected((s) => {
      const n = new Set(s);
      if (n.has(index)) n.delete(index);
      else n.add(index);
      return n;
    }),
    selectAll: (indexes) => setSelected((s) => new Set([...s, ...indexes])),
    deselectAll: () => setSelected(new Set()),
    fetchPlaylist, importCsv, loadJob,
    clear: () => {
      setPayload(null);
      setJob(null);
      setStates({});
      statesRef.current = {};
      setSelected(new Set());
      setError(null);
      setNotice(null);
    },
    start, downloadTrack, cancel, retry, downloadZip, refreshSettings, saveSettings,
    dismiss: () => {
      setError(null);
      setNotice(null);
    },
  }), [payload, job, states, selected, quality, loading, error, notice, settings, fetchPlaylist, importCsv, loadJob,
       start, downloadTrack, cancel, retry, downloadZip, refreshSettings, saveSettings]);

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}

export function useMusic(): Ctx {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error("useMusic must be used inside MusicProvider");
  return ctx;
}
