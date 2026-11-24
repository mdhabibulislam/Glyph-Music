"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CloudMusicProvider } from "@/lib/cloud-music";
import { MusicProvider } from "@/lib/music";

/** Picks the engine: the PC backend (local mode) or the site on its own (Vercel-only mode). */
export default function Providers({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"local" | "cloud" | null>(null);

  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => setMode(s?.mode === "cloud" ? "cloud" : "local"))
      .catch(() => setMode("local"));
  }, []);

  if (mode === null) return null; // a brief moment before the first paint of the app
  return mode === "cloud" ? <CloudMusicProvider>{children}</CloudMusicProvider> : <MusicProvider>{children}</MusicProvider>;
}
