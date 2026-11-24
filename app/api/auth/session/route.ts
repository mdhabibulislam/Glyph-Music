import type { NextRequest } from "next/server";
import { json } from "@/lib/server/guard";
import { COOKIE, verifySession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ok = await verifySession(req.cookies.get(COOKIE)?.value);
  return ok ? json(200, { authenticated: true }) : json(401, { authenticated: false });
}
