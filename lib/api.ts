// Thin client for the backend. Every call goes to this origin's /api proxy, so the
// HttpOnly session cookie is attached by the browser and never touched by script.

export type TrackStatus =
  | "idle" | "pending" | "searching" | "matched" | "downloading" | "converting"
  | "completed" | "failed" | "unavailable" | "cancelled";

export interface Track {
  index: number;
  spotify_id: string;
  title: string;
  artists: string[];
  artist: string;
  album: string;
  duration_ms: number;
  artwork_url: string | null;
  playable: boolean;
  duplicate_of: number | null;
}

export interface Playlist {
  id: string;
  kind: "playlist" | "album" | "track";
  source: "spotify" | "csv";
  source_url: string;
  name: string;
  owner: string;
  cover_url: string | null;
  tracks: Track[];
  truncated: boolean;
}

export interface TrackState {
  index: number;
  status: TrackStatus;
  progress: number;
  error: string;
  note: string;
  size: number;
  bitrate: number;
  file: string;
  available: boolean;
  score: number | null;
  source: { codec: string; kbps: number; lossless: boolean } | null;
}

export interface JobSummary {
  total: number;
  available: number;
  unavailable: number;
  duplicates: number;
  completed: number;
  failed: number;
  cancelled: number;
  batch_total: number;
  batch_done: number;
  remaining: number;
  percent: number;
  speed_bps: number;
  eta_seconds: number | null;
  bytes_total: number;
  current: { index: number; title: string; artist: string; status: TrackStatus } | null;
}

export interface JobSnapshot {
  id: string;
  version: number;
  running: boolean;
  cancelling: boolean;
  quality: number;
  summary: JobSummary;
  tracks: TrackState[];
}

export interface PlaylistPayload {
  playlist: Playlist;
  job: JobSnapshot;
  estimates: Record<string, number>;
  folder: string;
  library_count: number;
}

export interface HistoryItem {
  id: string;
  name: string;
  cover_url: string | null;
  source: string;
  started_at: number;
  updated_at: number;
  total: number;
  completed: number;
  failed: number;
  bytes: number;
  quality: number;
  folder: string;
}

export interface MusicSettings {
  default_quality: number;
  max_concurrent: number;
  download_folder: string;
  download_folder_effective: string;
  library_folders: string[];
  auto_zip: boolean;
  include_artwork: boolean;
  include_track_numbers: boolean;
  auto_cleanup: boolean;
  library: { tracks: number; running: boolean; scanned: number; found: number; error: string; finished_at: number };
  ffmpeg: boolean;
  qualities: number[];
  limits: { max_playlist_tracks: number; max_job_gb: number; max_source_file_mb: number };
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; allow401?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the Glyph Music backend. Is it running on your PC?");
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401 && !init.allow401) {
    window.location.href = "/login";
    throw new ApiError(401, "Your session has ended.");
  }
  if (!res.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : res.status >= 500
          ? "The Glyph Music backend isn't responding. Is it running on your PC?"
          : "That request couldn't be completed.";
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

/** Start a browser download without navigating away. */
export function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
