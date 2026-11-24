"use client";

import { useEffect, useRef } from "react";
import { ANIMALS, RAMPS } from "@/lib/glyph/animals";
import { useTweaks, type Tweaks } from "@/lib/tweaks";

interface Creature {
  x: number;
  y: number;
  /** Extra velocity from being scattered by the pointer; decays over time. */
  kx: number;
  ky: number;
  phase: number;
  pace: number;
  scale: number;
  hue: number;
  drift: number;
}

const CELL = [17, 13, 10]; // px per glyph cell for ASCII detail 1..3
const SPARKS = ["·", "+", "*", "✦", "."];

function spawn(w: number, h: number): Creature {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    kx: 0,
    ky: 0,
    phase: Math.random() * 100,
    pace: 0.75 + Math.random() * 0.5,
    scale: 0.8 + Math.random() * 0.45,
    hue: (Math.random() - 0.5) * 44,
    drift: (Math.random() - 0.5) * 0.5,
  };
}

/** Full-screen canvas of procedurally drawn ASCII animals on a near-black grid. */
export default function GlyphBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { tweaks } = useTweaks();
  const live = useRef<Tweaks>(tweaks);
  live.current = tweaks;
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = performance.now();
    let time = 0;
    const creatures: Creature[] = [];
    const pointer = { x: -9999, y: -9999, active: false };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced.matches) draw(0, true);
    };

    const draw = (dt: number, still: boolean) => {
      const t = live.current;
      const def = ANIMALS[t.animal];
      const cell = CELL[Math.max(0, Math.min(2, Math.round(t.detail) - 1))];
      const ramp = RAMPS[Math.max(0, Math.min(2, Math.round(t.detail) - 1))];
      const want = Math.round(t.density * Math.min(1.4, Math.max(0.45, (w * h) / (1440 * 900))));
      while (creatures.length < want) creatures.push(spawn(w, h));
      creatures.length = Math.min(creatures.length, want);

      // Trails: erase a fraction of the previous frame instead of clearing it.
      if (still) {
        ctx.clearRect(0, 0, w, h);
      } else {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = `rgba(0,0,0,${1 - Math.min(0.94, t.trail * 0.94)})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.font = `${Math.round(cell * 1.08)}px var(--font-geist-mono), ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const heading = (t.direction * Math.PI) / 180;
      const dirX = Math.cos(heading);
      const dirY = Math.sin(heading);
      const baseHue = 222 + t.hue;
      const radius = 7.5 * t.size * def.scale; // in cells
      const margin = radius * cell * 1.6;

      for (const c of creatures) {
        const r = radius * c.scale;
        const rpx = r * cell;
        if (!still) {
          const speed = 46 * t.speed * c.pace;
          const sway = Math.sin(time * 0.6 + c.phase) * def.bob;
          let vx = dirX * speed - dirY * sway * 26 * t.speed + c.kx;
          let vy = dirY * speed + dirX * sway * 26 * t.speed + c.ky;
          vx += -dirY * c.drift * speed * 0.4;
          vy += dirX * c.drift * speed * 0.4;
          // Scatter: animals bolt away from the pointer, then settle back on course.
          if (pointer.active) {
            const dx = c.x - pointer.x;
            const dy = c.y - pointer.y;
            const d = Math.hypot(dx, dy);
            const reach = 150 + rpx;
            if (d < reach) {
              const push = (1 - d / reach) * 2600 * dt;
              c.kx += (dx / (d || 1)) * push;
              c.ky += (dy / (d || 1)) * push;
            }
          }
          const decay = Math.exp(-dt * 1.9);
          c.kx *= decay;
          c.ky *= decay;
          c.x += vx * dt;
          c.y += vy * dt;
          if (c.x < -margin) c.x += w + margin * 2;
          else if (c.x > w + margin) c.x -= w + margin * 2;
          if (c.y < -margin) c.y += h + margin * 2;
          else if (c.y > h + margin) c.y -= h + margin * 2;
        }

        // Orientation: top-down animals face where they are going; side views just mirror.
        const mvx = dirX * 46 * t.speed + c.kx;
        const mvy = dirY * 46 * t.speed + c.ky;
        const angle = Math.atan2(mvy, mvx) + Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const mirror = mvx < 0 ? -1 : 1;
        const phase = (still ? 0.35 : time) * c.pace + c.phase;
        const hue = baseHue + c.hue;

        const c0 = Math.floor((c.x - rpx) / cell);
        const c1 = Math.ceil((c.x + rpx) / cell);
        const r0 = Math.floor((c.y - rpx) / cell);
        const r1 = Math.ceil((c.y + rpx) / cell);
        for (let gy = r0; gy <= r1; gy++) {
          const py = gy * cell + cell / 2;
          if (py < -cell || py > h + cell) continue;
          for (let gx = c0; gx <= c1; gx++) {
            const px = gx * cell + cell / 2;
            if (px < -cell || px > w + cell) continue;
            const lx = (px - c.x) / rpx;
            const ly = (py - c.y) / rpx;
            let u: number;
            let v: number;
            if (def.rotates) {
              u = lx * cos + ly * sin;
              v = -lx * sin + ly * cos;
            } else {
              u = lx * mirror;
              v = ly;
            }
            const i = def.shape(u, v, phase);
            if (i < 0.07) continue;
            const glint = t.sparkle > 0 && i < 0.4 && Math.random() < t.sparkle * 0.035;
            const ch = glint ? SPARKS[(Math.random() * SPARKS.length) | 0] : ramp[Math.min(ramp.length - 1, 1 + ((i * (ramp.length - 1)) | 0))];
            ctx.fillStyle = glint
              ? `hsla(${hue + 30},100%,92%,0.95)`
              : `hsla(${hue + i * 26},${70 + i * 25}%,${52 + i * 30}%,${0.2 + i * 0.75})`;
            ctx.fillText(ch, px, py);
          }
        }
      }

      // Ambient sparkle scattered over the grid.
      if (t.sparkle > 0) {
        const n = Math.round(t.sparkle * (still ? 60 : 5) * ((w * h) / (1440 * 900)));
        for (let k = 0; k < n; k++) {
          const px = ((Math.random() * w) / cell | 0) * cell + cell / 2;
          const py = ((Math.random() * h) / cell | 0) * cell + cell / 2;
          ctx.fillStyle = `hsla(${baseHue + Math.random() * 60 - 30},90%,${78 + Math.random() * 18}%,${0.25 + Math.random() * 0.5})`;
          ctx.fillText(SPARKS[(Math.random() * SPARKS.length) | 0], px, py);
        }
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      draw(dt, false);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches) {
        draw(0, true); // reduced motion: one calm, static frame
      } else if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    };
    const onLeave = () => (pointer.active = false);
    const onDown = (e: PointerEvent) => {
      // A click or tap sends a stronger shockwave through nearby animals.
      for (const c of creatures) {
        const dx = c.x - e.clientX;
        const dy = c.y - e.clientY;
        const d = Math.hypot(dx, dy);
        if (d < 320) {
          const push = (1 - d / 320) * 520;
          c.kx += (dx / (d || 1)) * push;
          c.ky += (dy / (d || 1)) * push;
        }
      }
    };

    redraw.current = () => {
      if (reduced.matches) draw(0, true);
    };
    resize();
    start();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", start);
    reduced.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", start);
      reduced.removeEventListener("change", start);
    };
  }, []);

  // With reduced motion there is no animation loop, so repaint when a tweak changes.
  useEffect(() => redraw.current(), [tweaks]);

  return (
    <div className="glyph-stage" aria-hidden="true">
      <div className="glyph-grid" />
      <canvas ref={canvasRef} className="glyph-canvas" />
      <div className="glyph-vignette" />
    </div>
  );
}
