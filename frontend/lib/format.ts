// Shared format helpers. Replaces per-screen duplicates.

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// Colombian pesos. `5000000` → `"$5.000.000"`. Returns "$0" for null/NaN.
export function formatCOP(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return "$0";
  const rounded = Math.round(amount);
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ── Dates ──

// "Jan 17". For lists/tables where the year is implied.
export function formatShortDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// "Jan 17, 2026". For ID/passport/visa docs where year matters.
export function formatLongDate(dateStr: string): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// "just now"/"5m ago"/"3h ago" for recent items, else "Jan 17". For file lists, chat-like UIs.
export function formatRelativeOrShortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// "5s ago"/"5m ago"/"3h ago"/"2d ago" or "never" for null. For status pings, service health.
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Track / media playback time ──

// "M:SS" from seconds. For media playback position/duration.
export function formatTrackTime(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// "M:SS" from milliseconds (just wraps formatTrackTime).
export function formatTrackDuration(ms: number): string {
  return formatTrackTime(ms / 1000);
}

// ── Long-form durations ──

// "5h 30m" or "45m". For session durations, runtimes.
export function formatLongDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// ── COP ──

// Compact COP for tight UI: handles negatives, billions, thousands.
export function formatCOPCompact(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return "$0";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return sign + "$" + (abs / 1_000_000_000).toFixed(1) + "B";
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(0) + "K";
  return sign + "$" + Math.round(abs);
}
