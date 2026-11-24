"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, FolderSearch, X } from "lucide-react";
import Composer from "@/components/Composer";
import PlaylistPanel from "@/components/PlaylistPanel";
import { greeting } from "@/lib/format";
import { useMusic } from "@/lib/music";

const NAME = "Habibul";

export default function HomePage() {
  const { payload, error, notice, dismiss, settings, loadJob } = useMusic();
  const [hello, setHello] = useState("");

  useEffect(() => {
    // Local time is only known in the browser, so the greeting is set after mount.
    const update = () => setHello(greeting(new Date().getHours(), NAME));
    update();
    const id = window.setInterval(update, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // /?job=<id> reopens a playlist from History.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    if (id && /^[0-9a-f]{32}$/.test(id)) {
      loadJob(id);
      window.history.replaceState(null, "", "/");
    }
  }, [loadJob]);

  const emptyLibrary = settings && settings.library.tracks === 0 && !settings.library.running;

  return (
    <>
      <section className={`text-center transition-all duration-700 ease-out ${payload ? "pb-7 pt-2" : "pb-9 pt-[12vh] sm:pt-[16vh]"}`}>
        <h1 className="rise min-h-[1.15em] text-balance text-4xl font-semibold tracking-tight sm:text-6xl">{hello || " "}</h1>
        <p className="rise mt-3 text-base text-ink/55 sm:text-lg" style={{ animationDelay: "60ms" }}>Your music. Your collection.</p>
      </section>

      <Composer />

      {!payload && (error || notice) && (
        <div className="glass rise mx-auto mt-5 w-full p-4 sm:p-5" style={{ maxWidth: "min(var(--composer-w), 100%)" }} role="alert">
          <div className="flex items-start justify-between gap-3">
            <p className={`text-sm leading-relaxed ${error ? "text-[#ffc9c9]" : "text-ink/75"}`}>{error?.message ?? notice}</p>
            <button className="btn-icon -m-1.5" onClick={dismiss} aria-label="Dismiss"><X className="h-4 w-4" /></button>
          </div>
          {error?.csvFallback && (
            <p className="mt-3 flex items-start gap-2 border-t border-white/[.07] pt-3 text-sm leading-relaxed text-ink/60">
              <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                You can still bring the playlist in: export it as a CSV (for example with Exportify) and choose{" "}
                <strong className="font-medium text-ink/85">Import CSV</strong> above. Any CSV with title and artist columns works.
              </span>
            </p>
          )}
        </div>
      )}

      {!payload && emptyLibrary && !error && (
        <div className="glass rise mx-auto mt-5 flex w-full items-center gap-4 p-4 sm:p-5" style={{ maxWidth: "min(var(--composer-w), 100%)", animationDelay: "200ms" }}>
          <FolderSearch className="h-6 w-6 shrink-0 text-accent" strokeWidth={1.6} />
          <p className="flex-1 text-sm leading-relaxed text-ink/65">
            Songs are matched against your own music library. Add the folder where your music lives to get started.
          </p>
          <Link href="/settings" className="btn shrink-0">Add folder</Link>
        </div>
      )}

      <PlaylistPanel />
    </>
  );
}
