"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FolderPlus, Loader2, LogOut, RefreshCw, ShieldCheck, Trash2, XCircle } from "lucide-react";
import MusicSettingsForm from "@/components/MusicSettingsForm";
import { api } from "@/lib/api";
import { useMusic } from "@/lib/music";

export default function SettingsPage() {
  const { settings, saveSettings, refreshSettings, error, dismiss } = useMusic();
  const [folder, setFolder] = useState("");

  // Follow a running library scan.
  useEffect(() => {
    if (!settings?.library.running) return;
    const id = window.setInterval(refreshSettings, 1000);
    return () => window.clearInterval(id);
  }, [settings?.library.running, refreshSettings]);

  useEffect(() => {
    dismiss();
    refreshSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSettings]);

  const folders = settings?.library_folders ?? [];

  const add = async () => {
    const value = folder.trim();
    if (!value) return;
    if (await saveSettings({ library_folders: [...folders, value] })) setFolder("");
  };

  const rescan = async () => {
    await api("/library/scan", { method: "POST" });
    refreshSettings();
  };

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST", allow401: true });
    } finally {
      window.location.href = "/login";
    }
  };

  const lib = settings?.library;

  return (
    <div className="rise space-y-5">
      <header>
        <p className="label">Settings</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your sanctuary</h1>
      </header>

      {error && <div className="rounded-2xl border border-err/30 bg-err/10 px-4 py-3 text-sm text-[#ffc9c9]" role="alert">{error.message}</div>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="glass p-5 sm:p-6">
          <h2 className="text-base font-semibold tracking-tight">Music library</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink/55">
            The audio source. Playlist songs are matched to files in these folders by title, artist and length, then converted to MP3.
          </p>

          <ul className="mt-4 space-y-1.5">
            {folders.map((f) => (
              <li key={f} className="glass-soft flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink/80" title={f}>{f}</span>
                <button className="btn-icon hover:!text-err" aria-label={`Remove ${f}`}
                        onClick={() => saveSettings({ library_folders: folders.filter((x) => x !== f) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
            {!folders.length && <li className="rounded-2xl border border-dashed border-white/15 px-4 py-5 text-center text-sm text-ink/45">No folders yet.</li>}
          </ul>

          <div className="mt-3 flex gap-2">
            <input className="field font-mono !text-xs" placeholder="C:\Users\You\Music" value={folder} spellCheck={false} aria-label="Music folder path"
                   onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <button className="btn btn-primary shrink-0" onClick={add} disabled={!folder.trim()}><FolderPlus className="h-4 w-4" />Add</button>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/[.07] pt-4">
            <p className="text-sm text-ink/65" aria-live="polite">
              {lib?.running ? (
                <span className="inline-flex items-center gap-2"><Loader2 className="spin h-4 w-4 text-accent" />Scanning&hellip; {lib.scanned} files</span>
              ) : (
                <><span className="font-mono text-ink">{lib?.tracks ?? 0}</span> songs indexed</>
              )}
              {lib?.error && <span className="mt-1 block text-xs text-err">{lib.error}</span>}
            </p>
            <button className="btn !py-2" onClick={rescan} disabled={!folders.length || lib?.running}><RefreshCw className="h-4 w-4" />Rescan</button>
          </div>
        </section>

        <section className="glass p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold tracking-tight">Downloads</h2>
          <MusicSettingsForm />
        </section>

        <section className="glass p-5 sm:p-6">
          <h2 className="text-base font-semibold tracking-tight">System</h2>
          <ul className="mt-4 space-y-3 text-sm">
            <li className="flex items-center gap-2.5">
              {settings?.ffmpeg ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-err" />}
              <span className="text-ink/75">{settings?.ffmpeg ? "FFmpeg is ready for MP3 conversion" : "FFmpeg was not found \u2013 run setup.bat"}</span>
            </li>
            <li className="flex items-center gap-2.5"><ShieldCheck className="h-4 w-4 text-ok" /><span className="text-ink/75">Signed in with a private, HttpOnly session</span></li>
          </ul>
          {settings && (
            <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-white/[.07] pt-4">
              {[
                ["Playlist limit", `${settings.limits.max_playlist_tracks} songs`],
                ["Job limit", `${settings.limits.max_job_gb} GB`],
                ["File limit", `${settings.limits.max_source_file_mb} MB`],
              ].map(([k, v]) => (
                <div key={k}><dt className="label">{k}</dt><dd className="mt-1 font-mono text-sm text-ink/85">{v}</dd></div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs text-ink/40">Limits are set in the <span className="font-mono">.env</span> file on your PC.</p>
        </section>

        <section className="glass p-5 sm:p-6">
          <h2 className="text-base font-semibold tracking-tight">Session</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink/55">You stay signed in on this device for seven days. Logging out ends the session everywhere it was copied.</p>
          <button className="btn btn-danger mt-5" onClick={logout}><LogOut className="h-4 w-4" />Logout</button>
        </section>
      </div>
    </div>
  );
}
