"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AnimalKind } from "./glyph/animals";

export interface Tweaks {
  animal: AnimalKind;
  density: number;
  speed: number;
  size: number;
  direction: number;
  hue: number;
  sparkle: number;
  trail: number;
  grid: number;
  detail: number;
  blur: number;
  refraction: number;
  tint: number;
  radius: number;
  composer: number;
}

export const DEFAULT_TWEAKS: Tweaks = {
  animal: "moth",
  density: 12,
  speed: 1,
  size: 1,
  direction: 335,
  hue: 0,
  sparkle: 0.35,
  trail: 0.55,
  grid: 0.4,
  detail: 2,
  blur: 22,
  refraction: 16,
  tint: 0.07,
  radius: 26,
  composer: 720,
};

const KEY = "glyph.tweaks.v1";

interface Ctx {
  tweaks: Tweaks;
  set: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  reset: () => void;
}

const TweaksContext = createContext<Ctx>({ tweaks: DEFAULT_TWEAKS, set: () => {}, reset: () => {} });

export function TweaksProvider({ children }: { children: ReactNode }) {
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULT_TWEAKS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      const next = { ...DEFAULT_TWEAKS };
      for (const k of Object.keys(DEFAULT_TWEAKS) as (keyof Tweaks)[]) {
        if (typeof saved[k] === typeof DEFAULT_TWEAKS[k]) (next as Record<string, unknown>)[k] = saved[k];
      }
      setTweaks(next);
    } catch {
      /* corrupted preferences: keep defaults */
    }
    setLoaded(true);
  }, []);

  // Visual preferences only - nothing sensitive is ever kept in browser storage.
  useEffect(() => {
    if (loaded) localStorage.setItem(KEY, JSON.stringify(tweaks));
  }, [tweaks, loaded]);

  // Glass parameters drive CSS variables so every surface updates live.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--glass-blur", `${tweaks.blur}px`);
    root.setProperty("--glass-tint", String(tweaks.tint));
    root.setProperty("--radius", `${tweaks.radius}px`);
    root.setProperty("--composer-w", `${tweaks.composer}px`);
    root.setProperty("--grid", String(tweaks.grid));
  }, [tweaks.blur, tweaks.tint, tweaks.radius, tweaks.composer, tweaks.grid]);

  const set = useCallback<Ctx["set"]>((key, value) => setTweaks((t) => ({ ...t, [key]: value })), []);
  const reset = useCallback(() => setTweaks(DEFAULT_TWEAKS), []);
  const value = useMemo(() => ({ tweaks, set, reset }), [tweaks, set, reset]);
  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export const useTweaks = () => useContext(TweaksContext);
