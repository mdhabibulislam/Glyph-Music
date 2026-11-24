"use client";

import { useEffect, useState } from "react";
import { RotateCcw, SlidersHorizontal, X } from "lucide-react";
import MusicSettingsForm from "@/components/MusicSettingsForm";
import { ANIMALS, ANIMAL_ORDER } from "@/lib/glyph/animals";
import { useTweaks, type Tweaks } from "@/lib/tweaks";

type NumericKey = Exclude<keyof Tweaks, "animal">;

interface SliderDef {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  show?: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const GROUPS: { title: string; items: SliderDef[] }[] = [
  {
    title: "Animals",
    items: [
      { key: "density", label: "Animal density", min: 1, max: 36, step: 1 },
      { key: "speed", label: "Animal speed", min: 0, max: 3, step: 0.05, show: (v) => `${v.toFixed(2)}×` },
      { key: "size", label: "Animal size", min: 0.5, max: 2.4, step: 0.05, show: (v) => `${v.toFixed(2)}×` },
      { key: "direction", label: "Direction", min: 0, max: 360, step: 5, show: (v) => `${v}°` },
    ],
  },
  {
    title: "Light",
    items: [
      { key: "hue", label: "Hue shift", min: -180, max: 180, step: 2, show: (v) => `${v > 0 ? "+" : ""}${v}°` },
      { key: "sparkle", label: "Sparkle", min: 0, max: 1, step: 0.01, show: pct },
      { key: "trail", label: "Trail intensity", min: 0, max: 1, step: 0.01, show: pct },
      { key: "grid", label: "Grid intensity", min: 0, max: 1, step: 0.01, show: pct },
      { key: "detail", label: "ASCII detail", min: 1, max: 3, step: 1, show: (v) => ["Coarse", "Balanced", "Fine"][v - 1] },
    ],
  },
  {
    title: "Glass",
    items: [
      { key: "blur", label: "Glass blur", min: 0, max: 48, step: 1, show: (v) => `${v}px` },
      { key: "refraction", label: "Glass refraction", min: 0, max: 60, step: 1 },
      { key: "tint", label: "Glass tint", min: 0, max: 0.3, step: 0.005, show: (v) => `${Math.round(v * 100)}%` },
      { key: "radius", label: "Corner radius", min: 8, max: 40, step: 1, show: (v) => `${v}px` },
      { key: "composer", label: "Composer width", min: 480, max: 960, step: 10, show: (v) => `${v}px` },
    ],
  },
];

export default function TweaksPanel() {
  const { tweaks, set, reset } = useTweaks();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"visual" | "music">("visual");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Open tweaks"
        aria-expanded={open}
        className={`glass glass-refract fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center !rounded-full text-ink/80 transition duration-300 hover:scale-105 hover:text-ink ${
          open ? "pointer-events-none scale-75 opacity-0" : ""
        }`}
      >
        <SlidersHorizontal className="h-5 w-5" strokeWidth={1.7} />
      </button>

      {/* Mobile: a bottom sheet. Desktop: a floating panel on the right. */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 md:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Tweaks"
        aria-hidden={!open}
        inert={!open}
        className={`glass fixed z-50 flex flex-col overflow-hidden transition-all duration-500 ease-[cubic-bezier(.2,.8,.2,1)]
          inset-x-0 bottom-0 max-h-[82dvh] !rounded-b-none
          md:inset-x-auto md:bottom-5 md:right-5 md:top-5 md:max-h-none md:w-[340px] md:!rounded-b-[var(--radius)]
          ${open ? "translate-y-0 opacity-100 md:translate-x-0" : "pointer-events-none translate-y-full opacity-0 md:translate-x-[110%] md:translate-y-0"}`}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-white/25 md:hidden" />
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Tweaks</h2>
            <p className="label mt-0.5">Glyph animals</p>
          </div>
          <div className="flex items-center gap-1">
            <button className="btn-icon" onClick={reset} aria-label="Reset visual tweaks" title="Reset visuals">
              <RotateCcw className="h-4 w-4" />
            </button>
            <button className="btn-icon" onClick={() => setOpen(false)} aria-label="Close tweaks">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mx-5 mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-black/25 p-1" role="tablist">
          {(["visual", "music"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-xl py-1.5 text-sm capitalize transition duration-200 ${tab === t ? "bg-white/[.14] text-ink" : "text-ink/50 hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="scroll-slim flex-1 overflow-y-auto px-5 pb-6">
          {tab === "visual" ? (
            <div className="space-y-6">
              <div>
                <p className="label mb-2">Animal</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {ANIMAL_ORDER.map((kind) => (
                    <button
                      key={kind}
                      onClick={() => set("animal", kind)}
                      aria-pressed={tweaks.animal === kind}
                      className={`rounded-xl border px-3 py-2 text-left text-sm transition duration-200 ${
                        tweaks.animal === kind ? "border-accent/60 bg-accent/20 text-ink" : "border-white/10 bg-white/5 text-ink/60 hover:text-ink"
                      } ${kind === "eagle" ? "col-span-2" : ""}`}
                    >
                      {ANIMALS[kind].label}
                    </button>
                  ))}
                </div>
              </div>
              {GROUPS.map((group) => (
                <div key={group.title}>
                  <p className="label mb-2">{group.title}</p>
                  <div className="space-y-2.5">
                    {group.items.map((s) => {
                      const value = tweaks[s.key];
                      return (
                        <div key={s.key}>
                          <div className="flex items-center justify-between text-sm">
                            <label htmlFor={`tw-${s.key}`} className="text-ink/75">{s.label}</label>
                            <span className="font-mono text-xs text-ink/50">{s.show ? s.show(value) : value}</span>
                          </div>
                          <input
                            id={`tw-${s.key}`} type="range" min={s.min} max={s.max} step={s.step} value={value}
                            style={{ ["--fill" as string]: `${((value - s.min) / (s.max - s.min)) * 100}%` }}
                            onChange={(e) => set(s.key, Number(e.target.value))}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-xs leading-relaxed text-ink/40">Visual preferences are saved in this browser only.</p>
            </div>
          ) : (
            <MusicSettingsForm compact />
          )}
        </div>
      </aside>
    </>
  );
}
