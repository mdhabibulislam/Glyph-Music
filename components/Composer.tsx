"use client";

import { useRef, useState, type FormEvent } from "react";
import { AudioLines, ClipboardPaste, FileSpreadsheet, Loader2, Search, X } from "lucide-react";
import { useMusic } from "@/lib/music";

/** Streaming-link badge: an original green mark (not a third-party logo). */
function StreamIcon({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center justify-center rounded-full bg-ok text-bg shadow-[0_0_18px_-4px_#1DB954] ${className}`} aria-hidden="true">
      <AudioLines className="h-[55%] w-[55%]" strokeWidth={2.4} />
    </span>
  );
}

export default function Composer() {
  const { fetchPlaylist, importCsv, loading, quality, setQuality, settings, mode } = useMusic();
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const qualities = settings?.qualities ?? [128, 192, 256, 320];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) fetchPlaylist(url.trim());
  };

  const paste = async () => {
    setHint(null);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) setUrl(text.slice(0, 400));
      input.current?.focus();
    } catch {
      setHint("Clipboard access was blocked. Press Ctrl+V in the box instead.");
      input.current?.focus();
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setHint("That CSV is larger than 5 MB.");
    setHint(null);
    await importCsv(f.name, await f.text());
    if (file.current) file.current.value = "";
  };

  return (
    <form onSubmit={submit} className="glass glass-refract rise mx-auto w-full p-3 sm:p-4" style={{ maxWidth: "min(var(--composer-w), 100%)", animationDelay: "120ms" }}>
      <div className="flex items-center gap-2 sm:gap-3">
        <StreamIcon className="ml-1 h-8 w-8 shrink-0 sm:h-9 sm:w-9" />
        <input
          ref={input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste your Spotify playlist link..."
          aria-label="Spotify playlist, album or song link"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={400}
          className="min-w-0 flex-1 bg-transparent py-3 text-base text-ink outline-none placeholder:text-ink/35 sm:text-lg"
        />
        {url && (
          <button type="button" className="btn-icon" onClick={() => { setUrl(""); input.current?.focus(); }} aria-label="Clear">
            <X className="h-4 w-4" />
          </button>
        )}
        <button type="button" className="btn !px-3" onClick={paste} aria-label="Paste from clipboard">
          <ClipboardPaste className="h-4 w-4" />
          <span className="hidden sm:inline">Paste</span>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[.07] pt-3">
        {mode === "cloud" ? (
          <span className="pill text-ink/60" title="Files are saved exactly as the artist published them">
            <AudioLines className="h-3 w-3 text-ok" /> Free &amp; open-licence music
          </span>
        ) : (
        <div className="flex items-center gap-2.5">
          <span className="label hidden sm:inline">Quality</span>
          <div className="flex rounded-2xl bg-black/25 p-1" role="radiogroup" aria-label="Audio quality">
            {qualities.map((q) => (
              <button
                key={q} type="button" role="radio" aria-checked={quality === q} onClick={() => setQuality(q)}
                className={`rounded-xl px-2.5 py-1.5 font-mono text-xs transition duration-200 sm:px-3 ${
                  quality === q ? "bg-white/[.15] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.2)]" : "text-ink/45 hover:text-ink"
                }`}
              >
                {q}<span className="hidden text-[10px] opacity-60 sm:inline"> kbps</span>
              </button>
            ))}
          </div>
        </div>
        )}
        <div className="flex flex-1 items-center justify-end gap-2">
          <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <button type="button" className="btn !px-3" onClick={() => file.current?.click()} disabled={loading} title="Import a playlist CSV (for example from Exportify)">
            <FileSpreadsheet className="h-4 w-4" />
            <span className="hidden sm:inline">Import CSV</span>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!url.trim() || loading}>
            {loading ? <Loader2 className="spin h-4 w-4" /> : <Search className="h-4 w-4" />}
            {loading ? "Fetching" : "Fetch Playlist"}
          </button>
        </div>
      </div>
      {hint && <p className="px-1 pt-2.5 text-xs text-ink/55">{hint}</p>}
    </form>
  );
}
