import type { NextRequest } from "next/server";
import { json, sameOrigin } from "@/lib/server/guard";
import { COOKIE } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json(403, { error: "Request origin is not allowed." });
  const res = json(200, { ok: true });
  res.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
