// Shared format helpers. Replaces per-screen duplicates.
//
// NOT YET CONSOLIDATED (name collisions across screens — same name, different intent):
//   - formatDate    — files.tsx (relative-or-short), finance.tsx (short Mon Day), identity.tsx (long w/year)
//   - formatTime    — music.tsx (M:SS track time), ServiceCard.tsx (relative "5m ago")
//   - formatDuration — music.tsx (M:SS), metrics.tsx ("5h 30m")
// Rename + consolidate these in a separate pass; doing it here would change behavior.

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
