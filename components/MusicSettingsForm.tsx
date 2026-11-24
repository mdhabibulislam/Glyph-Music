"use client";

import { useEffect, useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { useMusic } from "@/lib/music";

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-ink/90">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink/45">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full border transition duration-200 ${
          checked ? "border-transparent bg-accent" : "border-white/15 bg-white/10"
        }`}
      >
        <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${checked ? "left-[19px]" : "left-[3px]"}`} />
      </button>
    </label>
  );
}

/** Music preferences. Stored by the backend in SQLite; used in Settings and the Tweaks panel. */
export default function MusicSettingsForm({ compact = false }: { compact?: boolean }) {
  const { settings, saveSettings, mode } = useMusic();
  const cloud = mode === "cloud";
  const [folder, setFolder] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setFolder(settings.download_folder);
  }, [settings]);

  if (!settings) return <p className="py-6 text-center text-sm text-ink/45">Loading settings&hellip;</p>;

  const saveFolder = async () => {
    if (await saveSettings({ download_folder: folder })) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    }
  };

  return (
    <div className="space-y-5">
      {!cloud && (
      <div>
        <p className="label mb-2">Default audio quality</p>
        <div className="grid grid-cols-4 gap-1.5">
          {settings.qualities.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => saveSettings({ default_quality: q })}
              aria-pressed={settings.default_quality === q}
              className={`rounded-xl border px-1 py-2 font-mono text-xs transition duration-200 ${
                settings.default_quality === q ? "border-accent/60 bg-accent/20 text-ink" : "border-white/10 bg-white/5 text-ink/55 hover:text-ink"
              }`}
            >
              {q}
              <span className="ml-0.5 text-[10px] opacity-60">k</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink/45">
          An upper limit. A file is never encoded above the quality of its source.
        </p>
      </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="label">Simultaneous downloads</p>
          <span className="font-mono text-xs text-ink/70">{settings.max_concurrent}</span>
        </div>
        <input
          type="range" min={1} max={6} step={1} value={settings.max_concurrent} aria-label="Maximum simultaneous downloads"
          style={{ ["--fill" as string]: `${((settings.max_concurrent - 1) / 5) * 100}%` }}
          onChange={(e) => saveSettings({ max_concurrent: Number(e.target.value) })}
        />
      </div>

      {!cloud && (
      <div>
        <p className="label mb-2">Download folder</p>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
            <input
              className="field !pl-9 font-mono !text-xs" value={folder} spellCheck={false} aria-label="Download folder"
              placeholder={settings.download_folder_effective}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveFolder()}
            />
          </div>
          <button type="button" className="btn !px-3" onClick={saveFolder} disabled={folder === settings.download_folder}>
            {saved ? <Check className="h-4 w-4 text-ok" /> : "Save"}
          </button>
        </div>
        {!compact && (
          <p className="mt-2 break-all text-xs text-ink/45">
            Saving to <span className="font-mono text-ink/65">{settings.download_folder_effective}</span>. Leave empty for the default.
          </p>
        )}
      </div>
      )}

      <div className="divide-y divide-white/[.06]">
        <Toggle label="Automatic ZIP" hint={compact ? undefined : "Download the ZIP as soon as a playlist finishes."}
                checked={settings.auto_zip} onChange={(v) => saveSettings({ auto_zip: v })} />
        {!cloud && <>
        <Toggle label="Include album artwork" hint={compact ? undefined : "Embed cover art in each MP3."}
                checked={settings.include_artwork} onChange={(v) => saveSettings({ include_artwork: v })} />
        <Toggle label="Include track numbers" hint={compact ? undefined : "Write the playlist position into each MP3."}
                checked={settings.include_track_numbers} onChange={(v) => saveSettings({ include_track_numbers: v })} />
        <Toggle label="Clean up temporary files" hint={compact ? undefined : "Remove working files when a download ends."}
                checked={settings.auto_cleanup} onChange={(v) => saveSettings({ auto_cleanup: v })} />
        </>}
      </div>
    </div>
  );
}
