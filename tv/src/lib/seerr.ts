// Seerr discovery lane — the catalog brain (dir_1790443814736).
//
// KK's architecture: Seerr (Jellyseerr fork, TMDB-powered) PROVIDES everything —
// trending, search, details, availability, requests; Jellyfin is the playback
// engine. Requests flow Seerr → Sonarr/Radarr → qbit → disk → Jellyfin import,
// so "Request" here means "add to the library, automatically."
//
// The app talks to the bridge's /media/discover/* proxy (backend/bridge/routes/
// discover.js), which holds the Seerr API key server-side. Payloads mirror that
// file's slim shapes. Artwork comes from TMDB's public image CDN (metadata only —
// no user data leaves the infra).

import { call } from "./bridge";

// ── enums (mirror Seerr constants) ───────────────────────────────────────────

/** Seerr MediaStatus — what the library holds. */
export const MediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
} as const;

/** Seerr MediaRequestStatus — lifecycle of a request. */
export const RequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  MEDIA_AVAILABLE: 4,
  FAILED: 5,
} as const;

// ── types (mirror backend/bridge/routes/discover.js) ─────────────────────────

export interface Availability {
  status: number | null;
  jellyfinId: string | null;
  requested: boolean;
}

export type DiscoverMediaType = "movie" | "tv";

export interface DiscoverItem {
  tmdbId: number;
  mediaType: DiscoverMediaType;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number | null;
  releaseDate: string | null;
  availability: Availability | null;
}

export interface DiscoverPage {
  page: number;
  totalPages: number;
  results: DiscoverItem[];
}

export interface CastMember {
  name: string;
  character: string;
  profilePath: string | null;
}

export interface SeasonInfo {
  seasonNumber: number | null;
  name: string;
  episodeCount: number | null;
  airDate: string | null;
}

export interface DiscoverDetail {
  tmdbId: number;
  mediaType: DiscoverMediaType;
  title: string;
  tagline: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number | null;
  genres: { id: number; name: string }[];
  cast: CastMember[];
  similar: DiscoverItem[];
  recommendations: DiscoverItem[];
  availability: Availability | null;
  // movie
  releaseDate?: string | null;
  runtime?: number | null;
  // tv
  firstAirDate?: string | null;
  showStatus?: string | null;
  numberOfSeasons?: number | null;
  episodeRunTime?: number | null;
  seasons?: SeasonInfo[];
}

export interface RequestResult {
  ok: boolean;
  created: boolean;
  requestId?: number | null;
  status?: number | null;
  reason?: "nothing_to_request" | "duplicate";
  message?: string;
}

export interface RequestRow {
  id: number;
  status: number | null;
  createdAt: string | null;
  mediaType: DiscoverMediaType | null;
  tmdbId: number | null;
  requestedBy: string | null;
  is4k: boolean;
}

// ── TMDB artwork (public metadata CDN) ───────────────────────────────────────

const TMDB_IMG = "https://image.tmdb.org/t/p";

export function tmdbPoster(path: string | null | undefined, size: "w185" | "w342" | "w500" = "w342"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

export function tmdbBackdrop(path: string | null | undefined, size: "w780" | "w1280" | "original" = "w1280"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

export function tmdbProfile(path: string | null | undefined, size: "w185" = "w185"): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

// ── API (bridge /media/discover/* proxy; 15s — discovery must feel instant) ──

const T = 15000;

export function discoverHealth(): Promise<{ ok: boolean; version?: string | null; error?: string }> {
  return call("/media/discover/health", undefined, T);
}

export function discoverTrending(mediaType?: DiscoverMediaType, page = 1): Promise<DiscoverPage> {
  const mt = mediaType ? `&mediaType=${mediaType}` : "";
  return call(`/media/discover/trending?page=${page}${mt}`, undefined, T);
}

export function discoverMovies(page = 1): Promise<DiscoverPage> {
  return call(`/media/discover/movies?page=${page}`, undefined, T);
}

export function discoverTv(page = 1): Promise<DiscoverPage> {
  return call(`/media/discover/tv?page=${page}`, undefined, T);
}

export function discoverSearch(q: string, page = 1): Promise<DiscoverPage> {
  return call(`/media/discover/search?q=${encodeURIComponent(q)}&page=${page}`, undefined, T);
}

export function discoverDetail(tmdbId: number, mediaType: DiscoverMediaType): Promise<DiscoverDetail> {
  return call(`/media/discover/detail?type=${mediaType}&tmdbId=${tmdbId}`, undefined, T);
}

/** Ask Seerr to fetch media into the library (→ Sonarr/Radarr → qbit → Jellyfin). */
export function submitRequest(
  tmdbId: number,
  mediaType: DiscoverMediaType,
  seasons?: number[] | "all"
): Promise<RequestResult> {
  return call(
    "/media/discover/request",
    { method: "POST", body: JSON.stringify({ tmdbId, mediaType, seasons }) },
    T
  );
}

export function listRequests(): Promise<{ count: number; results: RequestRow[] }> {
  return call("/media/discover/requests", undefined, T);
}

// ── Watch orchestration (dir_1790443814736, KK 2026-10-02) ──────────────────
// "Click Watch → everything happens behind → Jellyfin plays." POST watch starts
// the pipeline (Seerr request, auto-approved → Sonarr/Radarr → qbit → import →
// the bridge nudges JF refresh + Seerr scan); GET watch is the one-stop poll:
// availability + request rows + REAL arr queue progress (percent/bytes).

export type ProgressStage =
  | "wanted"
  | "unreleased"
  | "unmonitored"
  | "downloading"
  | "partial"
  | "imported"
  | "unknown";

export interface WatchProgress {
  stage: ProgressStage | string;
  percent: number;
  sizeLeft?: number | null;
  size?: number | null;
  eta?: string | null;
  queued?: number | null;
  have?: number | null;
  aired?: number | null;
  statusText?: string | null;
  title?: string | null;
}

export interface WatchState {
  availability: Availability | null;
  requests: { id: number | null; status: number | null }[];
  progress: WatchProgress | null;
  nudged?: boolean;
}

export interface WatchStartResult {
  action: "play" | "requested" | "none";
  created?: boolean;
  reason?: "nothing_to_request" | "duplicate";
  message?: string;
  requestId?: number | null;
  status?: number | null;
  availability?: Availability | null;
}

/** One-stop orchestration state for the Watch button (poll target). */
export function watchState(tmdbId: number, mediaType: DiscoverMediaType): Promise<WatchState> {
  return call(`/media/discover/watch?type=${mediaType}&tmdbId=${tmdbId}`, undefined, T);
}

/** The Watch click: play-now when available, else fire the auto-approved request. */
export function watchStart(
  tmdbId: number,
  mediaType: DiscoverMediaType,
  seasons?: number[] | "all"
): Promise<WatchStartResult> {
  return call(
    "/media/discover/watch",
    { method: "POST", body: JSON.stringify({ tmdbId, mediaType, seasons }) },
    T
  );
}

// ── display helpers ──────────────────────────────────────────────────────────

export function isAvailable(a: Availability | null | undefined): boolean {
  return !!a && (a.status === MediaStatus.AVAILABLE || a.status === MediaStatus.PARTIALLY_AVAILABLE);
}

export function yearFrom(date: string | null | undefined): string {
  return date ? date.slice(0, 4) : "";
}
