"use client";

import { Ban, Loader2 } from "lucide-react";
import { useMusic } from "@/lib/music";
import { formatBytes, formatEta } from "@/lib/format";

function Stat({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p className={`mt-1 truncate font-mono text-sm ${tone || "text-ink/90"}`}>{value}</p>
    </div>
  );
}

/** Live progress, straight from the backend's own counters - nothing here is simulated. */
export default function ProgressPanel() {
  const { job, cancel } = useMusic();
  if (!job || job.summary.batch_total === 0) return null;
  const s = job.summary;
  const batchFailed = job.tracks.length ? s.failed : 0;

  return (
    <section className="glass-soft p-4 sm:p-5" aria-label="Download progress">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="label">{job.cancelling ? "Cancelling" : job.running ? "Downloading" : "Last download"}</p>
          <p className="mt-1 truncate text-sm text-ink/85" aria-live="polite">
            {job.running && s.current ? (
              <>
                <span className="capitalize text-accent">{s.current.status}</span>
                <span className="text-ink/35"> &middot; </span>
                {s.current.artist ? `${s.current.artist} – ` : ""}{s.current.title}
              </>
            ) : job.running ? "Preparing…" : `${s.batch_done} of ${s.batch_total} songs processed`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-2xl font-medium tabular-nums tracking-tight">{Math.floor(s.percent)}<span className="text-base text-ink/45">%</span></span>
          {job.running && (
            <button className="btn btn-danger !px-3" onClick={cancel} disabled={job.cancelling}>
              {job.cancelling ? <Loader2 className="spin h-4 w-4" /> : <Ban className="h-4 w-4" />}
              <span className="hidden sm:inline">Cancel</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(s.percent)}>
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${job.running ? "bar-live" : s.percent >= 100 && !batchFailed ? "bg-ok" : "bg-accent"}`}
          style={{ width: `${s.percent}%` }}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
        <Stat label="Speed" value={job.running && s.speed_bps > 0 ? `${formatBytes(s.speed_bps)}/s` : "–"} />
        <Stat label="Time left" value={job.running ? formatEta(s.eta_seconds) : "–"} />
        <Stat label="Completed" value={s.completed} tone="text-ok" />
        <Stat label="Remaining" value={s.remaining} />
        <Stat label="Failed" value={s.failed} tone={s.failed ? "text-err" : ""} />
        <Stat label="Downloaded" value={formatBytes(s.bytes_total)} />
      </div>
    </section>
  );
}
