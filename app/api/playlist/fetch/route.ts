import type { NextRequest } from "next/server";
import { json, requireSession } from "@/lib/server/guard";
import { fetchPlaylist, MetadataError } from "@/lib/server/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let url = "";
  try {
    const body = await req.json();
    if (typeof body?.url === "string") url = body.url;
  } catch {
    /* handled below */
  }
  try {
    return json(200, { playlist: await fetchPlaylist(url) });
  } catch (e) {
    if (e instanceof MetadataError) {
      return json(e.status, { error: e.message, code: e.code, ...(e.status === 502 ? { fallback: "csv" } : {}) });
    }
    return json(500, { error: "Something went wrong while reading that link." });
  }
}
