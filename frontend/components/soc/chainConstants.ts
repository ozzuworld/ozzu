// SOC v3 — kill-chain status + finding lifecycle + artifact-kind visual tokens.
// Single source of truth for the reporting screens (home / chain detail /
// findings board / engagement record), same role phaseColors.ts plays for
// engagement phases + severity. dir_1790538151856.

import { colors } from "../../lib/design-tokens";

// ── Kill-chain status pipeline ──
// Ordered disclosure pipeline: a chain walks this path left → right.

export const CHAIN_STATUS_ORDER = [
  "researching",
  "proven",
  "packaged",
  "submitted",
  "vendor-acked",
  "cve-assigned",
  "fix-shipped",
  "published",
] as const;

export type ChainStatus = (typeof CHAIN_STATUS_ORDER)[number] | (string & {});

export const CHAIN_STATUS_LABEL: Record<string, string> = {
  researching: "Researching",
  proven: "Proven",
  packaged: "Packaged",
  submitted: "Submitted",
  "vendor-acked": "Vendor ack",
  "cve-assigned": "CVE assigned",
  "fix-shipped": "Fix shipped",
  published: "Published",
};

export const CHAIN_STATUS_COLOR: Record<string, string> = {
  researching: colors.gray[300],
  proven: colors.info,
  packaged: colors.brand.purple,
  submitted: colors.warning,
  "vendor-acked": colors.brand.amberDeep,
  "cve-assigned": colors.brand.orange,
  "fix-shipped": colors.success,
  published: colors.accent,
};

export function chainStatusColor(status?: string | null): string {
  return CHAIN_STATUS_COLOR[status || ""] || colors.gray[300];
}

export function chainStatusLabel(status?: string | null): string {
  return CHAIN_STATUS_LABEL[status || ""] || status || "unknown";
}

// ── Finding lifecycle (dual axis: truth = kind, disclosure = lifecycle) ──

export const LIFECYCLE_ORDER = [
  "discovered",
  "filed",
  "packaged",
  "submitted",
  "vendor-acked",
  "cve-assigned",
  "fix-shipped",
  "published",
] as const;

// Off-pipeline parking states.
export const LIFECYCLE_EXTRA = ["held", "duplicate", "withdrawn"] as const;

export const LIFECYCLE_COLOR: Record<string, string> = {
  discovered: colors.gray[300],
  filed: colors.info,
  packaged: colors.brand.purple,
  submitted: colors.warning,
  "vendor-acked": colors.brand.amberDeep,
  "cve-assigned": colors.brand.orange,
  "fix-shipped": colors.success,
  published: colors.accent,
  held: "#FBBF24",
  duplicate: colors.gray[400],
  withdrawn: colors.error,
};

export function lifecycleColor(lifecycle?: string | null): string {
  if (!lifecycle) return colors.gray[400];
  return LIFECYCLE_COLOR[lifecycle] || colors.gray[400];
}

export function lifecycleLabel(lifecycle?: string | null): string {
  if (!lifecycle) return "unfiled";
  return lifecycle.replace(/-/g, " ");
}

// ── CVSS banding ──

export function cvssColor(v: number | string | null | undefined): string {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return colors.gray[400];
  if (n >= 9) return colors.error;
  if (n >= 7) return colors.brand.orange;
  if (n >= 4) return colors.warning;
  if (n > 0) return colors.info;
  return colors.gray[400];
}

export function fmtCvss(v: number | string | null | undefined): string | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return null;
  return n.toFixed(1);
}

// ── Artifact kinds ──

export const ARTIFACT_ICON: Record<string, string> = {
  advisory: "📄",
  readme: "📃",
  poc: "🧪",
  mitigations: "🛡️",
  banner: "🖼️",
  manifest: "🔒",
  "coordination-log": "✉️",
  other: "📎",
};

export function artifactIcon(kind?: string | null): string {
  return ARTIFACT_ICON[kind || ""] || ARTIFACT_ICON.other;
}

// ── Coordination ──

export const CHANNEL_COLOR: Record<string, string> = {
  psirt: colors.accent,
  zdi: colors.brand.purple,
  mitre: colors.brand.orange,
  email: colors.info,
};

export function channelColor(channel?: string | null): string {
  return CHANNEL_COLOR[(channel || "").toLowerCase()] || colors.gray[300];
}

export const DIRECTION_ICON: Record<string, string> = {
  sent: "↑",
  received: "↓",
  draft: "✎",
};

// ── Misc formatting ──

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

export function dropLabel(n: number | string | null | undefined): string | null {
  const num = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  return `DROP ${String(num).padStart(2, "0")}`;
}
