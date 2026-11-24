// Playlist CSV import in the browser (Exportify-style exports, or any CSV with a
// title column and an artist column).
import type { Playlist, Track } from "./api";
import { norm } from "./open";

const COLS: Record<string, string[]> = {
  title: ["track name", "title", "name", "track", "song", "song name", "track title"],
  artist: ["artist name(s)", "artist names", "artist name", "artists", "artist"],
  album: ["album name", "album"],
  duration: ["duration (ms)", "track duration (ms)", "duration_ms", "duration ms", "duration", "length", "time"],
  uri: ["track uri", "spotify uri", "uri", "track url", "spotify id", "track id"],
};

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function duration(value: string, isMs: boolean): number {
  const v = value.trim();
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Math.round(isMs || n > 30000 ? n : n * 1000);
  }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(v);
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : 0;
}

export function importCsvText(text: string, name: string, maxTracks = 1000): Playlist {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = parseRows(text, delimiter);
  if (!rows.length) throw new Error("That CSV is empty.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(COLS)) {
    const hit = names.map((n) => header.indexOf(n)).find((i) => i >= 0);
    if (hit !== undefined) col[key] = hit;
  }
  if (col.title === undefined) throw new Error("The CSV needs a header row with at least a 'Track Name' (or 'Title') column.");
  const isMs = col.duration !== undefined && header[col.duration].includes("ms");
  const cell = (row: string[], key: string) => (col[key] !== undefined ? (row[col[key]] || "").trim() : "");

  const tracks: Track[] = [];
  for (const row of rows.slice(1)) {
    const title = cell(row, "title");
    if (!title) continue;
    const artists = cell(row, "artist").split(/\s*[,;·]\s*/).map((a) => a.trim()).filter(Boolean).slice(0, 12);
    const id = /(?:track[:/])([A-Za-z0-9]{22})/.exec(cell(row, "uri")) || /^([A-Za-z0-9]{22})$/.exec(cell(row, "uri"));
    tracks.push({
      index: tracks.length,
      spotify_id: id ? id[1] : "",
      title: title.slice(0, 300),
      artists,
      artist: artists.join(", ").slice(0, 300),
      album: cell(row, "album").slice(0, 300),
      duration_ms: duration(cell(row, "duration"), isMs),
      artwork_url: null,
      playable: true,
      duplicate_of: null,
    });
    if (tracks.length >= maxTracks) break;
  }
  if (!tracks.length) throw new Error("No songs were found in that CSV.");

  const seen = new Map<string, number>();
  for (const t of tracks) {
    const keys = [`n:${norm(t.title)}|${norm(t.artist)}`];
    if (t.spotify_id) keys.push(`s:${t.spotify_id}`);
    const first = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
    t.duplicate_of = first ?? null;
    if (first === undefined) for (const k of keys) seen.set(k, t.index);
  }
  return {
    id: crypto.randomUUID().replace(/-/g, ""),
    kind: "playlist",
    source: "csv",
    source_url: "",
    name: name.replace(/\.csv$/i, "").trim().slice(0, 200) || "Imported playlist",
    owner: "",
    cover_url: null,
    tracks,
    truncated: false,
  };
}
