"use client";

import Link from "next/link";
import { Download, FileArchive, FolderOpen, Inbox } from "lucide-react";
import Artwork from "@/components/Artwork";
import ProgressPanel from "@/components/ProgressPanel";
import { triggerDownload } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useMusic } from "@/lib/music";

export default function DownloadsPage() {
  const { payload, job, states, downloadZip } = useMusic();

  if (!payload || !job) {
    return (
      <div className="glass rise mx-auto mt-[10vh] max-w-xl p-8 text-center">
        <Inbox className="mx-auto h-9 w-9 text-ink/35" strokeWidth={1.4} />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">No active download</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink/55">Fetch a playlist on the Home page to start one. Finished playlists are kept in History.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/" className="btn btn-primary">Go to Home</Link>
          <Link href="/history" className="btn">Open History</Link>
        </div>
      </div>
    );
  }

  const done = payload.playlist.tracks.filter((t) => states[t.index]?.status === "completed");

  return (
    <div className="rise space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="label">Downloads</p>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight">{payload.playlist.name}</h1>
        </div>
        <button className="btn btn-ok" onClick={() => downloadZip()} disabled={!job.summary.completed || job.running}>
          <FileArchive className="h-4 w-4" />Download ZIP
        </button>
      </header>

      {job.summary.batch_total > 0 ? <div className="glass p-3 sm:p-4"><ProgressPanel /></div> : (
        <div className="glass p-5 text-sm text-ink/55">Nothing has been downloaded from this playlist yet. Start it from <Link className="underline underline-offset-2" href="/">Home</Link>.</div>
      )}

      <section className="glass overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight">Finished songs <span className="ml-1 font-mono text-sm text-ink/45">{done.length}</span></h2>
          <p className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink/45" title={payload.folder}>
            <FolderOpen className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{payload.folder}</span>
          </p>
        </div>
        <ul className="scroll-slim max-h-[60vh] overflow-y-auto border-t border-white/[.07]">
          {done.map((t) => {
            const st = states[t.index];
            return (
              <li key={t.index} className="flex items-center gap-3 border-b border-white/[.05] px-5 py-2.5 hover:bg-white/[.035]">
                <Artwork sources={[t.artwork_url, `/api/jobs/${payload.playlist.id}/tracks/${t.index}/art`]} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13px]">{st.file}</p>
                  <p className="truncate text-xs text-ink/45">{st.bitrate} kbps &middot; {formatBytes(st.size)}{st.note ? ` · ${st.note}` : ""}</p>
                </div>
                <button className="btn-icon !text-ok" aria-label={`Save ${t.title}`}
                        onClick={() => triggerDownload(`/api/jobs/${payload.playlist.id}/tracks/${t.index}/file`)}>
                  <Download className="h-4 w-4" />
                </button>
              </li>
            );
          })}
          {!done.length && <li className="px-5 py-10 text-center text-sm text-ink/45">Finished songs will appear here.</li>}
        </ul>
      </section>
    </div>
  );
}
