"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle, Check, CircleDashed, CopyMinus, Download, FileArchive, Loader2, RotateCcw, Search, X,
} from "lucide-react";
import Artwork from "@/components/Artwork";
import ProgressPanel from "@/components/ProgressPanel";
import type { Track, TrackState, TrackStatus } from "@/lib/api";
import { formatBytes, formatDuration, formatLong } from "@/lib/format";
import { useMusic } from "@/lib/music";

const ACTIVE: TrackStatus[] = ["pending", "searching", "matched", "downloading", "converting"];

const STATUS: Record<string, { label: string; tone: string }> = {
  idle: { label: "Ready", tone: "text-ink/60" },
  pending: { label: "Pending", tone: "text-ink/60" },
  searching: { label: "Searching", tone: "text-accent" },
  matched: { label: "Matched", tone: "text-accent" },
  downloading: { label: "Downloading", tone: "text-accent" },
  converting: { label: "Converting", tone: "text-accent" },
  completed: { label: "Completed", tone: "text-ok" },
  failed: { label: "Failed", tone: "text-err" },
  unavailable: { label: "Unavailable", tone: "text-ink/40" },
  cancelled: { label: "Cancelled", tone: "text-ink/45" },
  duplicate: { label: "Duplicate", tone: "text-ink/40" },
};

function statusOf(track: Track, st: TrackState | undefined): string {
  if (track.duplicate_of !== null) return "duplicate";
  if (!st) return "idle";
  if (st.status === "idle" && !st.available) return "unavailable";
  return st.status;
}

function StatusPill({ status, title }: { status: string; title?: string }) {
  const s = STATUS[status] ?? STATUS.idle;
  const busy = ACTIVE.includes(status as TrackStatus) && status !== "pending";
  return (
    <span className={`pill ${s.tone}`} title={title}>
      {busy ? <Loader2 className="spin h-3 w-3" /> : status === "completed" ? <Check className="h-3 w-3" />
        : status === "failed" ? <AlertTriangle className="h-3 w-3" /> : status === "duplicate" ? <CopyMinus className="h-3 w-3" />
        : <CircleDashed className="h-3 w-3" />}
      {s.label}
    </span>
  );
}

function Fact({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="glass-soft min-w-0 px-3.5 py-2.5">
      <p className="label truncate">{label}</p>
      <p className={`mt-1 truncate text-[15px] font-medium tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

export default function PlaylistPanel() {
  const m = useMusic();
  const [query, setQuery] = useState("");
  const { payload, job, states, selected } = m;

  const rows = useMemo(() => {
    if (!payload) return [];
    const q = query.trim().toLowerCase();
    return payload.playlist.tracks.filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  }, [payload, query]);

  if (!payload || !job) return null;
  const { playlist } = payload;
  const s = job.summary;
  const selectable = (t: Track) => t.duplicate_of === null && !!states[t.index]?.available;
  const visibleSelectable = rows.filter(selectable).map((t) => t.index);
  const chosen = [...selected].filter((i) => states[i]?.available && playlist.tracks[i]?.duplicate_of === null);
  const totalMs = playlist.tracks.reduce((n, t) => n + (t.duplicate_of === null ? t.duration_ms : 0), 0);
  const estimate = payload.estimates[String(m.quality)] ?? 0;
  const retryable = s.failed + s.cancelled;
  const kind = playlist.kind === "track" ? "Song" : playlist.kind === "album" ? "Album" : "Playlist";

  return (
    <section className="glass rise mt-6 overflow-hidden" aria-label="Playlist results">
      {/* ---------------------------------------------------------------- header */}
      <div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-center sm:p-6">
        <Artwork sources={[playlist.cover_url, playlist.tracks[0]?.artwork_url, m.mode === "local" ? `/api/jobs/${playlist.id}/tracks/0/art` : null]} size={112}
                 className="shadow-[0_20px_40px_-18px_rgba(0,0,0,.9)]" />
        <div className="min-w-0 flex-1">
          <p className="label">{kind}{playlist.source === "csv" ? " · CSV import" : ""}</p>
          <h2 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl" title={playlist.name}>{playlist.name}</h2>
          {playlist.owner && <p className="mt-1 truncate text-sm text-ink/55">{playlist.owner}</p>}
        </div>
        <button className="btn-icon self-start" onClick={m.clear} aria-label="Close playlist" disabled={job.running} title={job.running ? "Cancel the download first" : "Close"}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-5 sm:px-6">
        <Fact label="Total songs" value={s.total} />
        <Fact label="Total duration" value={totalMs ? formatLong(totalMs) : "–"} />
        <Fact label="Estimated size" value={estimate ? `~${formatBytes(estimate)}` : "–"} />
        <Fact label="Available" value={s.available} tone="text-ok" />
        <Fact label="Unavailable" value={s.unavailable + s.duplicates} tone={s.unavailable ? "text-ink/60" : ""} />
      </div>

      {(playlist.truncated || s.duplicates > 0 || payload.library_count === 0) && (
        <div className="mx-4 mt-3 space-y-1.5 text-xs leading-relaxed text-ink/55 sm:mx-6">
          {payload.library_count === 0 && (
            <p className="text-[#ffd27a]">
              Your music library is empty, so nothing can be matched yet. Add your music folder in{" "}
              <a href="/settings" className="underline underline-offset-2">Settings</a>, then fetch again.
            </p>
          )}
          {playlist.truncated && (
            <p>Spotify&apos;s public page only lists the first 100 songs of a playlist. For the full list, export it as a CSV and use Import CSV.</p>
          )}
          {s.duplicates > 0 && <p>{s.duplicates} repeated {s.duplicates === 1 ? "song is" : "songs are"} skipped so nothing is downloaded twice.</p>}
        </div>
      )}

      {/* ---------------------------------------------------------------- progress */}
      <div className="px-4 pt-4 sm:px-6"><ProgressPanel /></div>

      {/* ---------------------------------------------------------------- toolbar */}
      <div className="flex flex-col gap-3 px-4 pb-3 pt-4 sm:px-6 lg:flex-row lg:items-center">
        <div className="flex items-center gap-2">
          <button className="btn !px-3 !py-2" onClick={() => m.selectAll(visibleSelectable)} disabled={!visibleSelectable.length}>Select all</button>
          <button className="btn !px-3 !py-2" onClick={m.deselectAll} disabled={!selected.size}>Deselect all</button>
          <div className="relative min-w-0 flex-1 lg:w-56 lg:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
            <input className="field !py-2 !pl-9" placeholder="Search songs" aria-label="Search songs" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          {retryable > 0 && !job.running && (
            <button className="btn !py-2" onClick={m.retry}><RotateCcw className="h-4 w-4" />Retry failed ({retryable})</button>
          )}
          <button className="btn !py-2" onClick={() => m.start(chosen)} disabled={!chosen.length || job.cancelling}>
            <Download className="h-4 w-4" />Download selected ({chosen.length})
          </button>
          <button className="btn btn-primary !py-2" onClick={() => m.start(null)} disabled={!s.available || job.cancelling}>
            <Download className="h-4 w-4" />Download all available
          </button>
          <button className="btn btn-ok !py-2" onClick={() => m.downloadZip()} disabled={!s.completed || job.running}
                  title={job.running ? "Available when the download finishes" : undefined}>
            <FileArchive className="h-4 w-4" />Download ZIP
          </button>
        </div>
      </div>

      {(m.error || m.notice) && (
        <div className={`mx-4 mb-3 flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm sm:mx-6 ${
          m.error ? "border-err/30 bg-err/10 text-[#ffc9c9]" : "border-white/10 bg-white/5 text-ink/70"}`} role="status">
          <span>{m.error?.message ?? m.notice}</span>
          <button className="btn-icon -m-1.5" onClick={m.dismiss} aria-label="Dismiss"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* ---------------------------------------------------------------- tracks */}
      <ul className="scroll-slim max-h-[62vh] overflow-y-auto border-t border-white/[.07]">
        {rows.map((t) => {
          const st = states[t.index];
          const status = statusOf(t, st);
          const active = ACTIVE.includes(status as TrackStatus);
          const canPick = selectable(t);
          const detail = st?.error || st?.note || (status === "duplicate" ? `Same song as #${(t.duplicate_of ?? 0) + 1}` : "")
            || (status === "unavailable" ? "No matching file in your music library" : "");
          return (
            <li key={t.index} className="relative grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 border-b border-white/[.05] px-4 py-2.5 transition-colors duration-200 hover:bg-white/[.035] sm:grid-cols-[auto_2rem_auto_1fr_auto_auto_auto] sm:px-6">
              <input type="checkbox" className="check" checked={selected.has(t.index) && canPick} disabled={!canPick}
                     onChange={() => m.toggle(t.index)} aria-label={`Select ${t.title}`} />
              <span className="hidden text-right font-mono text-xs text-ink/35 sm:block">{t.index + 1}</span>
              <Artwork sources={[t.artwork_url, m.mode === "local" && st?.available ? `/api/jobs/${playlist.id}/tracks/${t.index}/art` : null]} size={44} />
              <div className={`min-w-0 ${canPick || status === "completed" ? "" : "opacity-50"}`}>
                <p className="truncate text-sm font-medium" title={t.title}>{t.title}</p>
                <p className="truncate text-xs text-ink/50" title={t.artist}>{t.artist || "Unknown artist"}</p>
                {detail && <p className={`mt-0.5 truncate text-[11px] ${st?.error ? "text-err/90" : "text-ink/40"}`} title={detail}>{detail}</p>}
                <div className="mt-1 sm:hidden"><StatusPill status={status} title={detail} /></div>
              </div>
              <span className="hidden font-mono text-xs text-ink/45 sm:block">{formatDuration(t.duration_ms)}</span>
              <div className="hidden w-[118px] justify-end sm:flex"><StatusPill status={status} title={detail} /></div>
              <button
                className={`btn-icon ${status === "completed" ? "!text-ok" : ""}`}
                onClick={() => m.downloadTrack(t.index)}
                disabled={!canPick || active || job.cancelling}
                aria-label={status === "completed" ? `Save ${t.title}` : `Download ${t.title}`}
                title={status === "completed" ? `Save MP3${st?.bitrate ? ` (${st.bitrate} kbps, ${formatBytes(st.size)})` : ""}` : "Download this song"}
              >
                {active ? <Loader2 className="spin h-4 w-4" /> : <Download className="h-4 w-4" />}
              </button>
              {active && st && (
                <span className="absolute inset-x-0 bottom-0 h-px bg-white/5">
                  <span className="block h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(st.progress * 100)}%` }} />
                </span>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="px-6 py-10 text-center text-sm text-ink/45">No songs match &ldquo;{query}&rdquo;.</li>}
      </ul>
    </section>
  );
}
