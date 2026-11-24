// Shared between the server routes and the browser: an openly licensed recording
// found on the Internet Archive.

export interface OpenMatch {
  /** Direct MP3 address on archive.org. */
  url: string;
  size: number;
  seconds: number;
  kbps: number;
  /** Internet Archive item identifier; its page is https://archive.org/details/<item>. */
  item: string;
  itemTitle: string;
  creator: string;
  fileTitle: string;
  /** Licence address as published with the recording. */
  licence: string;
  licenceName: string;
  score: number;
}

/** "http://creativecommons.org/licenses/by-nc-sa/3.0/" -> "CC BY-NC-SA 3.0" */
export function licenceName(url: string): string {
  const u = (url || "").toLowerCase();
  const cc = u.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d+(?:\.\d+)?)/);
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  if (u.includes("publicdomain/zero")) return "CC0 (public domain)";
  if (u.includes("publicdomain")) return "Public domain";
  return "Open licence";
}

/** Only recordings published under Creative Commons or public-domain terms are accepted. */
export function isOpenLicence(url: string | undefined | null): boolean {
  return !!url && /^https?:\/\/(www\.)?creativecommons\.org\/(licenses|publicdomain)\//i.test(url.trim());
}

const PAREN = /[\(\[][^\)\]]*[\)\]]/g;
const FEAT = /\b(feat\.?|ft\.?|featuring)\b.*/i;
const SUFFIX = /\s+-\s+.*\b(remaster(ed)?|version|edit|mix|mono|stereo|deluxe|bonus|single|from)\b.*$/i;

function basic(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Normalise a title or artist for comparison (accents, punctuation, "(feat. X)", "- Remastered"). */
export function norm(s: string): string {
  const stripped = (s || "").replace(FEAT, "").replace(PAREN, " ").replace(SUFFIX, "");
  return basic(stripped) || basic(s);
}

/** 0..100 similarity (Dice coefficient over character pairs). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const n = pairs.get(p) || 0;
    if (n > 0) {
      pairs.set(p, n - 1);
      hits++;
    }
  }
  return (200 * hits) / (a.length + b.length - 2);
}

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

export function safeFilename(name: string, fallback = "untitled", max = 120): string {
  let n = (name || "").replace(ILLEGAL, " ").split(/\s+/).filter(Boolean).join(" ").replace(/^[ .]+|[ .]+$/g, "");
  if (!n) n = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n.split(".")[0])) n = `_${n}`;
  return n.slice(0, max).replace(/[ .]+$/g, "") || fallback;
}
