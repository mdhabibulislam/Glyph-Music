"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FolderOpen, History as HistoryIcon, Loader2, Trash2 } from "lucide-react";
import Artwork from "@/components/Artwork";
import { api, type HistoryItem } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { useMusic } from "@/lib/music";

export default function HistoryPage() {
  const router = useRouter();
  const { downloadZip, loadJob, payload, clear } = useMusic();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: HistoryItem[] }>("/history")).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load history.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const again = async (item: HistoryItem) => {
    setBusy(item.id);
    if (item.completed > 0) {
      await downloadZip(item.id);
    } else if (await loadJob(item.id)) {
      router.push("/"); // nothing finished last time: reopen it so it can be downloaded
    }
    setBusy(null);
  };

  const open = async (item: HistoryItem) => {
    setBusy(item.id);
    if (await loadJob(item.id)) router.push("/");
    setBusy(null);
  };

  const remove = async (item: HistoryItem) => {
    setBusy(item.id);
    setError(null);
    try {
      await api(`/history/${item.id}?files=${withFiles}`, { method: "DELETE" });
      if (payload?.playlist.id === item.id) clear();
      setConfirm(null);
      setWithFiles(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that entry.");
    }
    setBusy(null);
  };

  return (
    <div className="rise space-y-5">
      <header>
        <p className="label">History</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Past downloads</h1>
      </header>

      {error && <div className="rounded-2xl border border-err/30 bg-err/10 px-4 py-3 text-sm text-[#ffc9c9]" role="alert">{error}</div>}

      <section className="glass overflow-hidden">
        {items === null ? (
          <p className="flex items-center justify-center gap-2 px-6 py-14 text-sm text-ink/45"><Loader2 className="spin h-4 w-4" />Loading</p>
        ) : items.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <HistoryIcon className="mx-auto h-9 w-9 text-ink/30" strokeWidth={1.4} />
            <p className="mt-4 text-sm text-ink/50">Playlists you download will be listed here.</p>
          </div>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id} className="border-b border-white/[.06] px-4 py-4 last:border-0 sm:px-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <button className="flex min-w-0 flex-1 items-center gap-4 text-left" onClick={() => open(item)} title="Open playlist">
                    <Artwork sources={[item.cover_url, `/api/jobs/${item.id}/tracks/0/art`]} size={56} />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-medium tracking-tight">{item.name}</span>
                      <span className="mt-0.5 block text-xs text-ink/45">{formatDate(item.updated_at)}</span>
                    </span>
                  </button>
                  <dl className="grid grid-cols-4 gap-4 text-left sm:w-[330px] sm:shrink-0">
                    {[
                      ["Songs", item.total, ""],
                      ["Done", item.completed, "text-ok"],
                      ["Failed", item.failed, item.failed ? "text-err" : ""],
                      ["Size", formatBytes(item.bytes), ""],
                    ].map(([label, value, tone]) => (
                      <div key={label as string} className="min-w-0">
                        <dt className="label truncate">{label}</dt>
                        <dd className={`mt-1 truncate font-mono text-sm ${tone}`}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex shrink-0 items-center gap-2">
                    <button className="btn !py-2" onClick={() => again(item)} disabled={busy === item.id}>
                      {busy === item.id ? <Loader2 className="spin h-4 w-4" /> : <Download className="h-4 w-4" />}Download again
                    </button>
                    <button className="btn-icon hover:!text-err" onClick={() => { setConfirm(confirm === item.id ? null : item.id); setWithFiles(false); }}
                            aria-label={`Delete ${item.name} from history`} aria-expanded={confirm === item.id}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {confirm === item.id && (
                  <div className="glass-soft mt-3 flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex min-w-0 cursor-pointer items-start gap-2.5 text-sm text-ink/75">
                      <input type="checkbox" className="check mt-0.5" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
                      <span className="min-w-0">
                        Also delete the downloaded MP3 files
                        <span className="mt-0.5 flex items-center gap-1.5 break-all font-mono text-[11px] text-ink/40"><FolderOpen className="h-3 w-3 shrink-0" />{item.folder}</span>
                      </span>
                    </label>
                    <div className="flex shrink-0 gap-2">
                      <button className="btn !py-2" onClick={() => setConfirm(null)}>Keep</button>
                      <button className="btn btn-danger !py-2" onClick={() => remove(item)} disabled={busy === item.id}>
                        <Trash2 className="h-4 w-4" />{withFiles ? "Delete entry and files" : "Delete entry"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
