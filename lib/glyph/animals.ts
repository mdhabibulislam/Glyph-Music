// Procedural animals as density fields. Each function takes local coordinates in
// roughly [-1, 1] plus a time phase and returns an intensity 0..1, which the renderer
// maps onto an ASCII ramp. Nothing here is a sprite: every frame is computed.

export type AnimalKind = "moth" | "rabbit" | "turtle" | "squid" | "owl" | "fish" | "eagle";

export interface AnimalDef {
  label: string;
  /** Top-down animals rotate to face their heading; side-view animals only mirror. */
  rotates: boolean;
  /** Relative on-screen size. */
  scale: number;
  /** Vertical bobbing of the flight path, in body lengths. */
  bob: number;
  shape: (x: number, y: number, t: number) => number;
}

const ell = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const v = 1 - (dx * dx + dy * dy);
  return v > 0 ? v : 0;
};

const seg = (x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number) => {
  const vx = bx - ax;
  const vy = by - ay;
  const len = vx * vx + vy * vy || 1e-6;
  let h = ((x - ax) * vx + (y - ay) * vy) / len;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = x - (ax + vx * h);
  const dy = y - (ay + vy * h);
  const v = 1 - Math.sqrt(dx * dx + dy * dy) / r;
  return v > 0 ? v : 0;
};

const soft = (v: number, k = 1.6) => Math.min(1, v * k);

function moth(x: number, y: number, t: number) {
  const spread = 0.38 + 0.62 * Math.abs(Math.sin(t * 6.5));
  const ax = Math.abs(x);
  const wx = ax / spread;
  const body = soft(ell(x, y, 0, 0.02, 0.075, 0.44), 2.4);
  const upper = ell(wx, y, 0.48, -0.16, 0.46, 0.38);
  const lower = ell(wx, y, 0.34, 0.32, 0.31, 0.27);
  const veins = 0.62 + 0.38 * Math.cos(wx * 17 + y * 5);
  const spot = ell(wx, y, 0.52, -0.16, 0.13, 0.13);
  const antenna = seg(ax, y, 0.02, -0.42, 0.2, -0.8, 0.04) * 0.7;
  return Math.max(body, soft(upper) * 0.78 * veins, soft(lower) * 0.66 * veins, soft(spot, 3), antenna);
}

function eagle(x: number, y: number, t: number) {
  const flap = Math.sin(t * 3.1);
  const ax = Math.abs(x);
  let wing = 0;
  if (ax < 1) {
    const centre = -0.16 + flap * 0.42 * ax * ax + 0.14 * ax; // tips sweep back and beat
    const thick = 0.32 * (1 - ax * 0.5);
    const d = (y - centre) / thick;
    wing = Math.max(0, 1 - d * d) * Math.min(1, (1 - ax) * 5);
    if (ax > 0.66) wing *= 0.55 + 0.45 * Math.abs(Math.cos(y * 26 + ax * 9)); // primary feathers
  }
  const body = soft(ell(x, y, 0, 0.04, 0.11, 0.42), 2.2);
  const head = soft(ell(x, y, 0, -0.46, 0.085, 0.11), 3);
  const tail = ell(x, y, 0, 0.56, 0.2, 0.2) * (0.6 + 0.4 * Math.abs(Math.cos(x * 22)));
  return Math.max(body, head, soft(wing, 1.3) * 0.85, soft(tail) * 0.75);
}

function owl(x: number, y: number, t: number) {
  const flap = Math.sin(t * 2.6);
  const ax = Math.abs(x);
  const eye = ell(ax, y, 0.145, -0.44, 0.115, 0.115);
  if (eye > 0) {
    const blink = t % 5.2 < 0.16;
    if (blink) return Math.abs(y + 0.44) < 0.02 ? 0.9 : 0.25;
    return eye > 0.62 ? 1 : eye > 0.22 ? 0.12 : 0.85; // pupil, dark iris, bright rim
  }
  const body = ell(x, y, 0, 0.16, 0.36, 0.5);
  const breast = body * (0.58 + 0.42 * Math.cos(y * 24 + ax * 9));
  const head = soft(ell(x, y, 0, -0.42, 0.35, 0.28), 2);
  const tuft = seg(ax, y, 0.2, -0.6, 0.33, -0.84, 0.08);
  const wing = ell(ax, y, 0.46 + 0.14 * flap, 0.1, 0.2 + 0.1 * flap, 0.44) * 0.8;
  const beak = seg(x, y, 0, -0.36, 0, -0.27, 0.045);
  const feet = seg(ax, y, 0.13, 0.64, 0.13, 0.78, 0.045) * 0.7;
  return Math.max(soft(breast), head * 0.82, soft(tuft, 2), soft(wing), soft(beak, 3), feet);
}

function turtle(x: number, y: number, t: number) {
  const stroke = Math.sin(t * 2.3);
  const ax = Math.abs(x);
  const shell = ell(x, y, 0, 0.03, 0.4, 0.48);
  const plates = 0.5 + 0.5 * Math.abs(Math.cos(x * 9.5)) * Math.abs(Math.cos(y * 8 + 0.6));
  const head = soft(ell(x, y, 0, -0.62, 0.115, 0.15), 2.6);
  const front = seg(ax, y, 0.28, -0.28, 0.84, -0.3 + stroke * 0.32, 0.14);
  const rear = seg(ax, y, 0.27, 0.4, 0.5, 0.64 - stroke * 0.1, 0.095);
  const tail = seg(x, y, 0, 0.5, 0, 0.68, 0.045);
  return Math.max(soft(shell, 2.4) * plates, head, soft(front) * 0.8, soft(rear) * 0.7, tail * 0.6);
}

function squid(x: number, y: number, t: number) {
  const pulse = Math.sin(t * 3);
  const ax = Math.abs(x);
  const mantle = soft(ell(x, y, 0, -0.4, 0.2 * (1 + 0.09 * pulse), 0.5), 2);
  const fins = ell(ax, y, 0.2, -0.74, 0.21, 0.14) * 0.75;
  const head = soft(ell(x, y, 0, 0.12, 0.15, 0.12), 2.2);
  const eye = ell(ax, y, 0.09, 0.12, 0.04, 0.04);
  let arms = 0;
  if (y > 0.16 && y < 1) {
    const d = y - 0.16;
    for (let k = -3; k <= 3; k++) {
      const long = k === -3 || k === 3;
      if (!long && d > 0.6) continue;
      const px = k * 0.042 * (1 + d * 2.3 * (1 + 0.28 * pulse)) + Math.sin(y * 9 - t * 5 + k * 1.3) * 0.11 * d;
      const v = 1 - Math.abs(x - px) / 0.04;
      if (v > 0) arms = Math.max(arms, v * (1 - d * (long ? 0.55 : 1.1)));
    }
  }
  if (eye > 0.2) return 0.08;
  return Math.max(mantle * (0.72 + 0.28 * Math.cos(y * 14)), soft(fins), head, soft(arms, 1.4) * 0.85);
}

function rabbit(x: number, y: number, t: number) {
  const h = t * 4.4;
  const hop = Math.abs(Math.sin(h * 0.5));
  y += hop * 0.16 - 0.08; // the whole animal rises through the hop
  const stretch = Math.cos(h);
  if (ell(x, y, 0.49, -0.1, 0.035, 0.04) > 0) return 0.05; // eye
  const body = soft(ell(x, y, -0.04, 0.2, 0.42, 0.27), 2);
  const haunch = soft(ell(x, y, -0.28, 0.24, 0.25, 0.27), 2);
  const head = soft(ell(x, y, 0.43, -0.07, 0.19, 0.17), 2.4);
  const earA = seg(x, y, 0.38, -0.2, 0.22 + 0.06 * stretch, -0.76, 0.075);
  const earB = seg(x, y, 0.46, -0.22, 0.4 + 0.06 * stretch, -0.84, 0.07);
  const tail = soft(ell(x, y, -0.5, 0.1, 0.1, 0.1), 3);
  const fore = seg(x, y, 0.2, 0.36, 0.3 + 0.17 * stretch, 0.7, 0.06);
  const hind = seg(x, y, -0.3, 0.42, -0.36 - 0.22 * stretch, 0.72, 0.075);
  return Math.max(body, haunch, head, soft(earA, 2) * 0.9, soft(earB, 2) * 0.75, tail, soft(fore) * 0.8, soft(hind) * 0.85);
}

function fish(x: number, y: number, t: number) {
  const beat = 0.62 + 0.38 * Math.sin(t * 8);
  if (ell(x, y, 0.42, -0.035, 0.035, 0.035) > 0) return 0.05; // eye
  const taper = x < 0 ? 1 + x * 0.55 : 1;
  const body = soft(ell(x, y, 0, 0, 0.62, 0.16 * taper), 2.2);
  const scales = 0.7 + 0.3 * Math.cos(x * 30 + y * 12);
  const tailUp = seg(x, y, -0.56, 0, -0.9, -0.28, 0.075);
  const tailDown = seg(x, y, -0.56, 0, -0.92, 0.36, 0.08);
  const wingSpar = seg(x, y, 0.2, -0.05, -0.34, -0.7 * beat, 0.07);
  const wingFill = ell(x, y, -0.02, -0.32 * beat, 0.34, 0.3 * beat) * (0.5 + 0.5 * Math.abs(Math.cos((x - y) * 16)));
  const pelvic = seg(x, y, -0.12, 0.08, -0.34, 0.32, 0.06);
  return Math.max(body * scales, soft(tailUp), soft(tailDown), soft(wingSpar, 2), wingFill * 0.62, soft(pelvic) * 0.7);
}

export const ANIMALS: Record<AnimalKind, AnimalDef> = {
  moth: { label: "Moth", rotates: true, scale: 1, bob: 0.5, shape: moth },
  rabbit: { label: "Rabbit", rotates: false, scale: 0.95, bob: 0, shape: rabbit },
  turtle: { label: "Sea turtle", rotates: true, scale: 1.15, bob: 0.2, shape: turtle },
  squid: { label: "Squid", rotates: true, scale: 1.1, bob: 0.15, shape: squid },
  owl: { label: "Owl", rotates: false, scale: 1.05, bob: 0.35, shape: owl },
  fish: { label: "Flying fish", rotates: false, scale: 1.05, bob: 0.9, shape: fish },
  eagle: { label: "Eagle", rotates: true, scale: 1.3, bob: 0.15, shape: eagle },
};

export const ANIMAL_ORDER: AnimalKind[] = ["moth", "rabbit", "turtle", "squid", "owl", "fish", "eagle"];

export const RAMPS = [
  " .:+*#",
  " .:-=+*#%@",
  " .'`,:;~-_+<>i!lI?/|()1{}[]rcvunxzjftLCJUYXZO0Qoahkbdpqwm*WMB8&%$#@",
];
