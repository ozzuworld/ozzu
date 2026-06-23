// SOC engagement_phase + finding severity → color tokens.
// Single source of truth so the list card, phase pill, severity pills, and
// finding rows all stay aligned. Imported by every soc/* component.

import { colors } from "../../lib/design-tokens";

export const PHASE_ORDER = [
  "scoping",
  "recon",
  "enumeration",
  "foothold",
  "exploitation",
  "post_exploit",
  "reporting",
] as const;

export type EngagementPhase = (typeof PHASE_ORDER)[number] | (string & {});

export function phaseColor(phase?: string | null): string {
  switch (phase) {
    case "recon": return colors.brand.blue;
    case "enumeration": return colors.brand.cyan;
    case "foothold": return colors.brand.amber;
    case "exploitation": return colors.brand.orange;
    case "post_exploit": return colors.brand.purple;
    case "reporting": return colors.success;
    case "scoping": return colors.gray[250];
    default: return colors.gray[250];
  }
}

export function phaseLabel(phase?: string | null): string {
  if (!phase) return "scoping";
  return phase.replace(/_/g, " ");
}

// ── Severity ──

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number] | (string & {});

export function severityColor(severity?: string | null): string {
  switch ((severity || "").toLowerCase()) {
    case "critical": return colors.error;
    case "high": return colors.brand.orange;
    case "medium": return colors.warning;
    case "low": return colors.brand.blue;
    case "info": return colors.gray[200];
    default: return colors.gray[200];
  }
}

export function severityIcon(severity?: string | null): string {
  switch ((severity || "").toLowerCase()) {
    case "critical": return "🔴";
    case "high": return "🟠";
    case "medium": return "🟡";
    case "low": return "🔵";
    case "info": return "⚪";
    default: return "·";
  }
}
