// Ozzu bridge media API client — the broker lane (dir_1790443814736, P2).
//
// The bridge (GCP, home.ozzu.world/bridge) exposes /media/*: resolver (Prowlarr
// search → infoHash), broker file-pick (stremio-server on bridge-01), and
// permanent resume markers (ozzu-postgres). Media BYTES never flow through the
// bridge — the player streams direct from bridge-01 (LAN 192.168.1.9:11470).
//
// Auth mirrors the iOS app (frontend/lib/bridge-api.ts): Bearer key whenever
// configured. EXPO_PUBLIC_BRIDGE_API_KEY is inlined at bundle time (CI secret /
// backend/.env for local OTA exports). LAN/WG requests are allowed keyless by
// the bridge, so an unset key only breaks the public path.

const BRIDGE_URL = (process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge").replace(/\/+$/, "");
const BRIDGE_KEY = process.env.EXPO_PUBLIC_BRIDGE_API_KEY || "";

// Stream hosts (must match the bridge's MEDIA_LAN_HOST / MEDIA_WG_HOST).
const MEDIA_LAN_HOST = "192.168.1.9";

const FETCH_TIMEOUT_MS = 130000; // resolver searches can ride a cold flaresolverr (~140s)

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", ...(extra || {}) };
  if (BRIDGE_KEY) h.Authorization = `Bearer ${BRIDGE_KEY}`;
  return h;
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      headers: headers(init?.body ? { "Content-Type": "application/json" } : undefined),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data as any).error) || `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── types (mirror backend/bridge/routes/media.js) ────────────────────────────

export interface SearchResult {
  title: string;
  infoHash: string;
  magnet: string | null;
  seeders: number | null;
  leechers: number | null;
  size: number | null;
  quality: string;
  indexer: string | null;
  tmdbId: number | null;
  age: number | null;
  score: number;
}

export interface ResolvedFile {
  idx: number;
  path: string;
  size: number | null;
}

export interface ResolveResult {
  infoHash: string;
  name: string | null;
  file?: ResolvedFile;
  stream?: { lan: string; wg: string; relative: string };
  fileCount?: number;
  loading?: boolean;
  error?: string;
}

export interface Marker {
  id: number;
  user_id: string;
  kind: "movie" | "episode";
  title: string;
  tmdb_id: number | null;
  season: number | null;
  episode: number | null;
  info_hash: string;
  file_idx: number;
  file_name: string | null;
  position_seconds: number;
  duration_seconds: number | null;
  watched: boolean;
  created_at: string;
  updated_at: string;
}

export interface MarkerInput {
  kind: "movie" | "episode";
  title: string;
  tmdbId?: number | null;
  season?: number | null;
  episode?: number | null;
  infoHash: string;
  fileIdx?: number;
  fileName?: string | null;
  positionSeconds?: number;
  durationSeconds?: number | null;
  watched?: boolean;
}

// ── API ──────────────────────────────────────────────────────────────────────

/** LAN stream URL for a broker file (TV is always home-LAN; WG/remote later). */
export function brokerStreamLan(infoHash: string, fileIdx: number): string {
  return `http://${MEDIA_LAN_HOST}:11470/${infoHash}/${fileIdx}`;
}

export function mediaSearch(q: string, type: "movie" | "show", limit = 12): Promise<{ count: number; results: SearchResult[] }> {
  return call(`/media/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`);
}

export function mediaResolve(
  infoHash: string,
  opts: { season?: number; episode?: number; movie?: boolean } = {}
): Promise<ResolveResult> {
  return call("/media/resolve", { method: "POST", body: JSON.stringify({ infoHash, ...opts }) });
}

export function markersContinue(userId = "kk"): Promise<{ count: number; markers: Marker[] }> {
  return call(`/media/markers?continue=1&userId=${encodeURIComponent(userId)}`, undefined, 15000);
}

export function markerUpsert(m: MarkerInput): Promise<Marker> {
  return call("/media/markers", { method: "PUT", body: JSON.stringify(m) }, 15000);
}

export function markerDelete(id: number): Promise<{ ok: boolean }> {
  return call(`/media/markers?id=${id}`, { method: "DELETE" }, 15000);
}

/** Delete-after-watched: drop the torrent from the broker engine (client rule). */
export function brokerRemove(infoHash: string): Promise<{ ok: boolean }> {
  return call("/media/broker/remove", { method: "POST", body: JSON.stringify({ infoHash }) }, 15000);
}
