// Finds a song among openly licensed recordings on the Internet Archive.
//
// Only three curated collections are searched - netlabel releases, the Free Music
// Archive mirror and the Jamendo mirror - and only items that carry a Creative Commons
// or public-domain licence. General community uploads are deliberately excluded.
import { isOpenLicence, licenceName, norm, similarity, type OpenMatch } from "@/lib/open";

const COLLECTIONS = "collection:(netlabels OR freemusicarchive OR jamendo-albums)";
const UA = "GlyphMusic/1.0 (personal music library tool)";
const MAX_FILE_BYTES = 400 * 1024 * 1024;

interface Item {
  identifier: string;
  title: string;
  creator: string;
  licence: string;
}

interface ArchiveFile {
  name?: string;
  format?: string;
  title?: string;
  artist?: string;
  creator?: string;
  length?: string;
  size?: string;
}

export interface Wanted {
  title: string;
  artist: string;
  artists: string[];
  duration_ms: number;
}

// Small per-instance caches: tracks in a playlist often share artists and albums.
const searchCache = new Map<string, Promise<Item[]>>();
const filesCache = new Map<string, Promise<ArchiveFile[]>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load().catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, hit);
    if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": UA }, cache: "no-store", signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`archive.org answered ${res.status}`);
  return res.json();
}

const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v));
const phrase = (s: string) => s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/** Releases by an artist. With `song`, only releases whose own title mentions the song
 *  (singles, and albums named after it) - prolific artists have hundreds of releases. */
function searchItems(artist: string, song = ""): Promise<Item[]> {
  const who = phrase(artist);
  const what = phrase(song);
  return remember(searchCache, `${who}|${what}`.toLowerCase(), async () => {
    const q = `${COLLECTIONS} AND mediatype:audio AND licenseurl:[* TO *] AND (creator:("${who}") OR title:("${who}"))` +
      (what ? ` AND title:("${what}")` : "");
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&sort[]=downloads+desc&rows=${what ? 8 : 25}&output=json`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await getJson(url)) as any;
    const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
    return docs
      .map((d: Record<string, unknown>) => ({
        identifier: first(d.identifier), title: first(d.title), creator: first(d.creator), licence: first(d.licenseurl),
      }))
      .filter((d: Item) => /^[A-Za-z0-9._-]{1,120}$/.test(d.identifier) && isOpenLicence(d.licence));
  });
}

function itemFiles(identifier: string): Promise<ArchiveFile[]> {
  return remember(filesCache, identifier, async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}/files`)) as any;
    return Array.isArray(data?.result) ? data.result : [];
  });
}

function seconds(length: string | undefined): number {
  if (!length) return 0;
  if (/^\d+(\.\d+)?$/.test(length)) return Number(length);
  const parts = length.split(":").map(Number);
  return parts.some(Number.isNaN) ? 0 : parts.reduce((total, p) => total * 60 + p, 0);
}

function artistScore(wanted: Wanted, ...candidates: string[]): number {
  const primary = norm(wanted.artists[0] || wanted.artist);
  const all = norm(wanted.artist);
  let best = 0;
  for (const c of candidates) {
    const n = norm(c);
    if (!n) continue;
    best = Math.max(best, similarity(primary, n), similarity(all, n), n.includes(primary) || primary.includes(n) ? 90 : 0);
  }
  return best;
}

/** Strip "Artist - " and leading track numbers that often prefix a file's title. */
function cleanTitle(title: string, artist: string): string {
  let t = title.replace(/^\s*\d{1,3}\s*[-._)]\s*/, "");
  const a = norm(artist);
  const dash = t.split(/\s+[-\u2013\u2014]\s+/);
  if (dash.length > 1 && a && similarity(norm(dash[0]), a) > 75) t = dash.slice(1).join(" - ");
  return t;
}

export async function findOpenTrack(wanted: Wanted): Promise<OpenMatch | null> {
  const artist = wanted.artists[0] || wanted.artist;
  const title = norm(wanted.title);
  if (!title || !norm(artist)) return null;

  // Releases named after the song first, then the artist's most downloaded releases.
  const [named, general] = await Promise.all([
    searchItems(artist, wanted.title.replace(/[\(\[].*$/, "")).catch(() => [] as Item[]),
    searchItems(artist),
  ]);
  const seen = new Set<string>();
  const items = [...named, ...general].filter((i) => {
    if (seen.has(i.identifier) || artistScore(wanted, i.creator, i.title) < 70) return false;
    seen.add(i.identifier);
    return true;
  });
  if (!items.length) return null;
  const closeness = (i: Item) => similarity(norm(cleanTitle(i.title, artist)), title);
  items.sort((a, b) => closeness(b) - closeness(a));

  const want = wanted.duration_ms / 1000;
  let best: OpenMatch | null = null;
  for (const item of items.slice(0, 4)) {
    let files: ArchiveFile[];
    try {
      files = await itemFiles(item.identifier);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.name || !/mp3/i.test(f.format || "") || !/\.mp3$/i.test(f.name)) continue;
      const size = Number(f.size) || 0;
      if (size < 50_000 || size > MAX_FILE_BYTES) continue;
      const label = f.title || f.name.replace(/\.mp3$/i, "").split("/").pop() || "";
      const tScore = similarity(norm(cleanTitle(label, artist)), title);
      if (tScore < 86) continue;
      if (artistScore(wanted, f.artist || "", f.creator || "", item.creator, item.title) < 70) continue;
      const have = seconds(f.length);
      const diff = want && have ? Math.abs(want - have) : 0;
      if (diff > 12) continue; // same name but a different recording
      const score = tScore - diff * 0.6;
      if (!best || score > best.score) {
        best = {
          url: `https://archive.org/download/${encodeURIComponent(item.identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
          size,
          seconds: have,
          kbps: have ? Math.round((size * 8) / have / 1000) : 0,
          item: item.identifier,
          itemTitle: item.title.slice(0, 200),
          creator: (f.artist || f.creator || item.creator).slice(0, 200),
          fileTitle: label.slice(0, 200),
          licence: item.licence,
          licenceName: licenceName(item.licence),
          score: Math.round(score * 10) / 10,
        };
      }
    }
    if (best && best.score >= 97) break;
  }
  return best;
}
