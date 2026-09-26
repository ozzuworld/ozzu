// Time / runtime formatting for the TV media client.
// Subset of frontend/lib/format.ts, copied because tv/ cannot import from frontend/.

// Jellyfin expresses durations/positions in "ticks" = 100-nanosecond units.
const TICKS_PER_SECOND = 1e7;

export function ticksToSeconds(ticks?: number | null): number {
  return (ticks || 0) / TICKS_PER_SECOND;
}

export function secondsToTicks(seconds: number): number {
  return Math.round((seconds || 0) * TICKS_PER_SECOND);
}

/** 3725s -> "1:02:05"; 185s -> "3:05" */
export function formatTime(totalSeconds: number): string {
  let s = Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0);
  if (s < 0) s = 0;
  const sec = s % 60;
  const min = Math.floor(s / 60) % 60;
  const hr = Math.floor(s / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hr > 0 ? `${hr}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

/** runtime ticks -> "1h 25m" / "48m" */
export function formatRuntime(ticks?: number | null): string {
  const mins = Math.round(ticksToSeconds(ticks) / 60);
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Production year for a movie/series, falling back to the premiere date. */
export function yearOf(item: {
  ProductionYear?: number | null;
  PremiereDate?: string | null;
}): string {
  if (item.ProductionYear) return String(item.ProductionYear);
  if (item.PremiereDate) return item.PremiereDate.slice(0, 4);
  return "";
}

/** 0..1 watched fraction from Jellyfin UserData (PlayedPercentage or position/runtime). */
export function watchedFraction(item: {
  UserData?: { PlayedPercentage?: number | null; PlaybackPositionTicks?: number | null } | null;
  RunTimeTicks?: number | null;
}): number {
  const ud = item.UserData;
  if (!ud) return 0;
  if (typeof ud.PlayedPercentage === "number" && ud.PlayedPercentage > 0) {
    return Math.max(0, Math.min(1, ud.PlayedPercentage / 100));
  }
  const pos = ud.PlaybackPositionTicks || 0;
  const total = item.RunTimeTicks || 0;
  if (pos > 0 && total > 0) return Math.max(0, Math.min(1, pos / total));
  return 0;
}
