// Shared constants for OSINT components

export const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high: "#F97316",
  medium: "#EAB308",
  low: "#3B82F6",
  info: "#6B7280",
};

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const CATEGORY_EMOJI: Record<string, string> = {
  breach: "💀",
  account_found: "👤",
  exposure: "🌐",
};

export const CATEGORY_LABELS: Record<string, string> = {
  breach: "BREACH",
  account_found: "ACCOUNT",
  exposure: "EXPOSURE",
};

export const FINDING_STATUS_EMOJI: Record<string, string> = {
  new: "🆕",
  acknowledged: "👁",
  remediated: "✅",
  false_positive: "🚫",
};

export const FINDING_STATUS_COLORS: Record<string, string> = {
  new: "#EF4444",
  acknowledged: "#EAB308",
  remediated: "#22C55E",
  false_positive: "#6B7280",
};

export const PROFILE_TYPE_EMOJI: Record<string, string> = {
  email: "📧",
  username: "👤",
  password: "🔑",
  phone: "📱",
  domain: "🌐",
};

export function scoreColor(score: number): string {
  if (score >= 70) return "#EF4444";
  if (score >= 40) return "#F97316";
  if (score >= 20) return "#EAB308";
  return "#22C55E";
}

export function scoreLabel(score: number): string {
  if (score >= 70) return "HIGH RISK";
  if (score >= 40) return "MODERATE";
  if (score >= 20) return "LOW RISK";
  return "CLEAN";
}
