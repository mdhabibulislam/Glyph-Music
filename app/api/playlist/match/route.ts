import type { NextRequest } from "next/server";
import { json, requireSession } from "@/lib/server/guard";
import { findOpenTrack, type Wanted } from "@/lib/server/openmusic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 6;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Search the open-licence collections for a small batch of songs. */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let list: unknown;
  try {
    list = (await req.json())?.tracks;
  } catch {
    list = null;
  }
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) {
    return json(422, { error: `Send between 1 and ${MAX_BATCH} songs at a time.` });
  }
  const results = await Promise.all(
    list.map(async (raw) => {
      const index = Number(raw?.index);
      const wanted: Wanted = {
        title: text(raw?.title, 300),
        artist: text(raw?.artist, 300),
        artists: Array.isArray(raw?.artists) ? raw.artists.slice(0, 12).map((a: unknown) => text(a, 200)).filter(Boolean) : [],
        duration_ms: Math.max(0, Number(raw?.duration_ms) || 0),
      };
      try {
        return { index, match: await findOpenTrack(wanted), error: false };
      } catch {
        return { index, match: null, error: true };
      }
    }),
  );
  return json(200, { results });
}
