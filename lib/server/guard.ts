import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifySession } from "./session";

export function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** State-changing requests must come from this site itself (CSRF protection). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients send no Origin; they still need the session cookie
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") || req.headers.get("host"));
  } catch {
    return false;
  }
}

/** Returns an error response, or null when the request is allowed. */
export async function requireSession(req: NextRequest): Promise<NextResponse | null> {
  if (req.method !== "GET" && !sameOrigin(req)) return json(403, { error: "Request origin is not allowed." });
  if (!(await verifySession(req.cookies.get(COOKIE)?.value))) return json(401, { error: "Not signed in." });
  return null;
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown").trim().slice(0, 64);
}

// ---- login rate limiting -------------------------------------------------------
// Kept in memory, so it is per server instance: it slows guessing but, unlike the
// PC backend's limiter, a serverless platform can't guarantee a single counter.
const MAX = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const WINDOW = Number(process.env.LOGIN_WINDOW_SECONDS || 900) * 1000;
const fails = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (fails.get(key) || []).filter((t) => now - t < WINDOW);
  fails.set(key, list);
  return list;
}

export function retryAfter(ip: string): number {
  const now = Date.now();
  let wait = 0;
  for (const [key, limit] of [[`c:${ip}`, MAX], ["*", MAX * 6]] as const) {
    const list = recent(key, now);
    if (list.length >= limit) wait = Math.max(wait, Math.ceil((list[0] + WINDOW - now) / 1000));
  }
  return wait;
}

export function recordFailure(ip: string): number {
  const now = Date.now();
  for (const key of [`c:${ip}`, "*"]) recent(key, now).push(now);
  if (fails.size > 5000) for (const [k, v] of fails) if (!v.length) fails.delete(k);
  return Math.max(0, MAX - (fails.get(`c:${ip}`)?.length || 0));
}

export function clearFailures(ip: string) {
  fails.delete(`c:${ip}`);
}
