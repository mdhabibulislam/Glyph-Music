"use client";

import { useEffect, useState } from "react";
import { Music } from "lucide-react";

/** Cover art with graceful fallbacks: first source, then the next, then a glyph tile. */
export default function Artwork({ sources, size, className = "" }: { sources: (string | null | undefined)[]; size: number; className?: string }) {
  const list = sources.filter(Boolean) as string[];
  const key = list.join("|");
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [key]);
  const src = list[i];
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-gradient-to-br from-white/10 to-accent/10 ${className}`}
      style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.2) }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer"
             className="h-full w-full object-cover" onError={() => setI((n) => n + 1)} />
      ) : (
        <Music className="text-ink/35" style={{ width: size * 0.42, height: size * 0.42 }} strokeWidth={1.6} />
      )}
    </div>
  );
}
