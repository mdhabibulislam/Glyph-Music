import type { NextRequest } from "next/server";
import { clearFailures, clientIp, json, recordFailure, retryAfter, sameOrigin } from "@/lib/server/guard";
import { codeMatches, COOKIE, isConfigured, signSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json(403, { error: "Request origin is not allowed." });
  if (!isConfigured()) return json(409, { error: "No access code has been set yet.", code: "env_required" });
  const ip = clientIp(req);
  const wait = retryAfter(ip);
  if (wait) {
    return json(429, { error: "Too many incorrect attempts. Try again later.", retry_after: wait }, { "Retry-After": String(wait) });
  }

  let code = "";
  try {
    const body = await req.json();
    if (typeof body?.code === "string") code = body.code;
  } catch {
    /* handled below */
  }
  if (!code || code.length > 256) return json(422, { error: "Enter your access code." });

  if (!(await codeMatches(code))) {
    const left = recordFailure(ip);
    await new Promise((r) => setTimeout(r, 600)); // blunt brute-force attempts
    return json(401, { error: "Incorrect access code.", attempts_left: left });
  }
  clearFailures(ip);
  const { token, maxAge } = await signSession();
  const res = json(200, { ok: true, expires_in: maxAge });
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
