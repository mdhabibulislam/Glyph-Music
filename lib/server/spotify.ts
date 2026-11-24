// Playlist metadata from Spotify's public embed pages. Metadata only - never audio.
import type { Playlist, Track } from "@/lib/api";
import { norm } from "@/lib/open";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ID = "[A-Za-z0-9]{22}";
const URL_RE = new RegExp(
  `^https://open\\.spotify\\.com/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?(?:embed/)?(playlist|album|track)/(${ID})/?(?:\\?[^\\s#]*)?(?:#\\S*)?$`,
);
const URI_RE = new RegExp(`^spotify:(playlist|album|track):(${ID})$`);
const NEXT_DATA = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const EMBED_LIMIT = 100;
export const MAX_TRACKS = Number(process.env.MAX_PLAYLIST_TRACKS || 1000);

export class MetadataError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "metadata_error", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Only the kind and ID are used to build the outbound request, so a pasted URL can
 *  never point the server at another host (SSRF). */
export function parseSpotifyUrl(input: string): { kind: "playlist" | "album" | "track"; id: string } {
  const url = (input || "").trim();
  const m = url.length <= 400 ? URL_RE.exec(url) || URI_RE.exec(url) : null;
  if (!m) {
    if (/^https?:\/\/(spotify\.link|spotify\.app\.link)\//.test(url)) {
      throw new MetadataError("Short spotify.link URLs aren't supported. Open it and copy the full open.spotify.com link.", "bad_url", 422);
    }
    throw new MetadataError("Paste a Spotify playlist, album or song link (https://open.spotify.com/...).", "bad_url", 422);
  }
  return { kind: m[1] as "playlist" | "album" | "track", id: m[2] };
}

export function isAllowedImage(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && (u.port === "" || u.port === "443") &&
      (u.hostname.endsWith(".scdn.co") || u.hostname.endsWith(".spotifycdn.com"));
  } catch {
    return false;
  }
}

function bestImage(sources: unknown): string | null {
  let best: string | null = null;
  let width = -1;
  for (const s of Array.isArray(sources) ? sources : []) {
    const w = Number(s?.width ?? s?.maxWidth ?? 0);
    if (isAllowedImage(s?.url) && w >= width) {
      best = s.url;
      width = w;
    }
  }
  return best;
}

const splitArtists = (text: string) => (text || "").split(/\s*[,;·]\s*| /).map((a) => a.trim()).filter(Boolean);

export function makeTrack(index: number, t: { title: string; artists: string[]; album?: string; duration_ms?: number; spotify_id?: string; artwork_url?: string | null; playable?: boolean }): Track {
  const artists = t.artists.map((a) => a.trim()).filter(Boolean).slice(0, 12);
  return {
    index,
    spotify_id: t.spotify_id || "",
    title: (t.title || "").trim().slice(0, 300),
    artists,
    artist: artists.join(", ").slice(0, 300),
    album: (t.album || "").trim().slice(0, 300),
    duration_ms: Math.max(0, Math.round(Number(t.duration_ms) || 0)),
    artwork_url: isAllowedImage(t.artwork_url) ? t.artwork_url : null,
    playable: t.playable !== false,
    duplicate_of: null,
  };
}

export function markDuplicates(tracks: Track[]) {
  const seen = new Map<string, number>();
  for (const t of tracks) {
    const keys = [`n:${norm(t.title)}|${norm(t.artist)}`];
    if (t.spotify_id) keys.push(`s:${t.spotify_id}`);
    const first = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
    t.duplicate_of = first ?? null;
    if (first === undefined) for (const k of keys) seen.set(k, t.index);
  }
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function parseEmbedHtml(html: string, kind: "playlist" | "album" | "track", sid: string): Playlist {
  const m = NEXT_DATA.exec(html);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entity: any;
  try {
    entity = JSON.parse(m![1]).props.pageProps.state.data.entity;
  } catch {
    entity = null;
  }
  if (!entity) {
    throw new MetadataError("Spotify didn't share this item's details (it may be private, or the page changed). Use Import CSV instead.", "layout");
  }
  const cover = bestImage(entity.coverArt?.sources) || bestImage(entity.visualIdentity?.image);
  const name = String(entity.name || entity.title || `Spotify ${kind}`).slice(0, 200);
  const tracks: Track[] = [];
  if (kind === "track") {
    let artists = (Array.isArray(entity.artists) ? entity.artists : []).map((a: { name?: string }) => a?.name || "");
    if (!artists.filter(Boolean).length && entity.subtitle) artists = splitArtists(String(entity.subtitle));
    tracks.push(makeTrack(0, { title: name, artists, duration_ms: entity.duration, spotify_id: sid, artwork_url: cover, playable: entity.isPlayable }));
  } else {
    for (const item of Array.isArray(entity.trackList) ? entity.trackList : []) {
      if (!item?.title) continue;
      const uri = String(item.uri || "");
      tracks.push(makeTrack(tracks.length, {
        title: String(item.title),
        artists: splitArtists(String(item.subtitle || "")),
        album: kind === "album" ? name : "",
        duration_ms: item.duration,
        spotify_id: uri.startsWith("spotify:track:") ? uri.split(":").pop() : "",
        artwork_url: kind === "album" ? cover : null,
        playable: item.isPlayable,
      }));
      if (tracks.length >= MAX_TRACKS) break;
    }
  }
  if (!tracks.length) throw new MetadataError("No songs were found at that link.", "empty");
  markDuplicates(tracks);
  return {
    id: newId(),
    kind,
    source: "spotify",
    source_url: `https://open.spotify.com/${kind}/${sid}`,
    name,
    owner: kind !== "track" ? String(entity.subtitle || "").slice(0, 200) : "",
    cover_url: cover,
    tracks,
    truncated: kind === "playlist" && tracks.length >= EMBED_LIMIT,
  };
}

export async function fetchPlaylist(url: string): Promise<Playlist> {
  const { kind, id } = parseSpotifyUrl(url);
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: { "user-agent": UA, "accept-language": "en" },
      redirect: "manual", // never follow a redirect to another host
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MetadataError("Couldn't reach Spotify right now. Try again, or use Import CSV.", "network");
  }
  if (res.status === 404) throw new MetadataError("Spotify says this link doesn't exist, or it's private.", "not_found");
  if (res.status === 429) throw new MetadataError("Spotify is rate-limiting requests right now. Try again in a minute.", "rate_limited");
  if (res.status !== 200) throw new MetadataError(`Spotify returned HTTP ${res.status}. Use Import CSV instead.`, "blocked");
  const html = await res.text();
  if (html.length > 8 * 1024 * 1024) throw new MetadataError("Spotify's response was unexpectedly large.", "blocked");
  return parseEmbedHtml(html, kind, id);
}
