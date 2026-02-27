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
  infrastructure: "🏗",
  metadata: "🔬",
  secret: "🔐",
  vulnerability: "⚠️",
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
  ip: "📡",
};

export const CORRELATION_TYPE_EMOJI: Record<string, string> = {
  name_match: "👤",
  email_username_link: "🔗",
  shared_breach: "💀",
  platform_overlap: "🔄",
  domain_association: "🌐",
};

export const CORRELATION_TYPE_LABELS: Record<string, string> = {
  name_match: "NAME MATCH",
  email_username_link: "EMAIL-USERNAME",
  shared_breach: "SHARED BREACH",
  platform_overlap: "PLATFORM OVERLAP",
  domain_association: "DOMAIN LINK",
};

export const CORRELATION_TYPE_COLORS: Record<string, string> = {
  name_match: "#06B6D4",
  email_username_link: "#3B82F6",
  shared_breach: "#EF4444",
  platform_overlap: "#A855F7",
  domain_association: "#22C55E",
};

export const MODULE_EMOJI: Record<string, string> = {
  "hibp-email": "💀",
  "hibp-password": "🔑",
  "username-enum": "👤",
  "dns-recon": "🌐",
  "whois-lookup": "📋",
  "ip-lookup": "📡",
  "social-media": "🔗",
  "phone-lookup": "📱",
  "image-meta": "🖼",
  "dkim-probe": "🔏",
  "spf-check": "📧",
};

export const MODULE_LABELS: Record<string, string> = {
  "hibp-email": "HIBP",
  "hibp-password": "HIBP-PW",
  "username-enum": "USER-ENUM",
  "dns-recon": "DNS",
  "whois-lookup": "WHOIS",
  "ip-lookup": "IP",
  "social-media": "SOCIAL",
  "phone-lookup": "PHONE",
  "image-meta": "IMG-META",
  "dkim-probe": "DKIM",
  "spf-check": "SPF",
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
