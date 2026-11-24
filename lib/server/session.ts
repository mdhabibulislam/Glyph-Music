// Vercel-only mode: sessions and the access-code check, using Web Crypto so the same
// code runs in the edge middleware and in route handlers. The access code is read from
// the ADMIN_ACCESS_CODE environment variable and never leaves the server.

export const COOKIE = "glyph_session";
const MIN_CODE = 8;
const encoder = new TextEncoder();

export function backendUrl(): string {
  return (process.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
}

function accessCode(): string {
  return (process.env.ADMIN_ACCESS_CODE || "").trim();
}

export function isConfigured(): boolean {
  return accessCode().length >= MIN_CODE;
}

export function sessionDays(): number {
  const n = Number(process.env.SESSION_EXPIRY_DAYS || 7);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? n : 7;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** The signing key depends on the access code, so changing the code signs every device out. */
async function signingKey(): Promise<CryptoKey> {
  const material = await sha256(`glyph-session:${process.env.SESSION_SECRET || ""}:${accessCode()}`);
  return crypto.subtle.importKey("raw", material as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(): Promise<{ token: string; maxAge: number }> {
  const maxAge = sessionDays() * 86400;
  const now = Math.floor(Date.now() / 1000);
  const body = toB64(encoder.encode(JSON.stringify({ iat: now, exp: now + maxAge })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(`session.${body}`)));
  return { token: `${body}.${toB64(sig)}`, maxAge };
}

export async function verifySession(token: string | undefined | null): Promise<boolean> {
  if (!isConfigured() || !token || token.length > 1024) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const ok = await crypto.subtle.verify("HMAC", await signingKey(), fromB64(parts[1]) as BufferSource, encoder.encode(`session.${parts[0]}`));
    if (!ok) return false;
    const data = JSON.parse(new TextDecoder().decode(fromB64(parts[0])));
    return typeof data.exp === "number" && data.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/** Constant-time comparison (both sides are hashed first, so length doesn't leak either). */
export async function codeMatches(supplied: string): Promise<boolean> {
  if (!isConfigured()) return false;
  const [a, b] = await Promise.all([sha256(`code:${accessCode()}`), sha256(`code:${supplied}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
