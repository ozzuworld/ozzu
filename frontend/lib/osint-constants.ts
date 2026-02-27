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
  image: "🖼",
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
  "exif-extract": "📸",
  "reverse-image": "🔍",
  "avatar-compare": "🪞",
  // CLI tools (Epic 6)
  "sherlock-cli": "🔎",
  "maigret-cli": "🕵",
  "holehe-cli": "📬",
  "phoneinfoga-cli": "📞",
  "amass-cli": "🗺",
  "nuclei-cli": "☢",
  "exiftool-cli": "🏷",
  "h8mail-cli": "📨",
  "theharvester-cli": "🌾",
  // Threat intel (Epic 6)
  "virustotal-lookup": "🦠",
  "abuseipdb-lookup": "🚨",
  "otx-lookup": "🛰",
  "urlhaus-check": "🕸",
  // Defensive intelligence (Epic 7)
  "ghunt-email": "🔍",
  "dnstwist-scan": "🎭",
  "crtsh-monitor": "📜",
  "darkweb-search": "🕵",
  "leak-search": "💧",
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
  "exif-extract": "EXIF",
  "reverse-image": "REV-IMG",
  "avatar-compare": "AVATAR",
  // CLI tools (Epic 6)
  "sherlock-cli": "SHERLOCK",
  "maigret-cli": "MAIGRET",
  "holehe-cli": "HOLEHE",
  "phoneinfoga-cli": "PHONEINFOGA",
  "amass-cli": "AMASS",
  "nuclei-cli": "NUCLEI",
  "exiftool-cli": "EXIFTOOL",
  "h8mail-cli": "H8MAIL",
  "theharvester-cli": "HARVESTER",
  // Threat intel (Epic 6)
  "virustotal-lookup": "VIRUSTOTAL",
  "abuseipdb-lookup": "ABUSEIPDB",
  "otx-lookup": "OTX",
  "urlhaus-check": "URLHAUS",
  // Defensive intelligence (Epic 7)
  "ghunt-email": "GHUNT",
  "dnstwist-scan": "DNSTWIST",
  "crtsh-monitor": "CRT.SH",
  "darkweb-search": "DARK WEB",
  "leak-search": "INTELX",
};

export const ALERT_TYPE_EMOJI: Record<string, string> = {
  new_finding: "🆕",
  critical_finding: "🔴",
  high_finding: "🟠",
  score_increase: "📈",
  score_decrease: "📉",
  new_breach: "💀",
  finding_resolved: "✅",
  scan_complete: "🔄",
};

export const ALERT_TYPE_LABELS: Record<string, string> = {
  new_finding: "NEW FINDING",
  critical_finding: "CRITICAL",
  high_finding: "HIGH RISK",
  score_increase: "SCORE UP",
  score_decrease: "SCORE DOWN",
  new_breach: "NEW BREACH",
  finding_resolved: "RESOLVED",
  scan_complete: "SCAN DONE",
};

export const REMEDIATION_TYPE_EMOJI: Record<string, string> = {
  opt_out: "🚫",
  password_change: "🔑",
  account_delete: "🗑",
  privacy_setting: "🔒",
  abuse_report: "📋",
  metadata_strip: "🧹",
  dns_config: "🌐",
  "2fa_enable": "🛡",
  enable_2fa: "🛡",
  identity_monitoring: "👁",
  credential_rotation: "🔄",
  domain_monitoring: "🌐",
  cert_review: "📜",
  account_review: "👤",
  investigate: "🔍",
};

export const REMEDIATION_STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔧",
  completed: "✅",
  dismissed: "🚫",
};

export const REMEDIATION_STATUS_COLORS: Record<string, string> = {
  pending: "#EAB308",
  in_progress: "#3B82F6",
  completed: "#22C55E",
  dismissed: "#6B7280",
};

// SOC Incident Status
export const INCIDENT_STATUS_EMOJI: Record<string, string> = {
  open: "🔴",
  investigating: "🔍",
  contained: "🛡",
  eradication: "🧹",
  resolved: "✅",
  closed: "🔒",
};

export const INCIDENT_STATUS_COLORS: Record<string, string> = {
  open: "#EF4444",
  investigating: "#F97316",
  contained: "#EAB308",
  eradication: "#3B82F6",
  resolved: "#22C55E",
  closed: "#6B7280",
};

export const NIST_PHASE_LABELS: Record<string, string> = {
  preparation: "1. PREPARATION",
  identification: "2. IDENTIFICATION",
  containment: "3. CONTAINMENT",
  eradication: "4. ERADICATION",
  recovery: "5. RECOVERY",
  lessons_learned: "6. LESSONS LEARNED",
};

export const INCIDENT_CLASSIFICATION_EMOJI: Record<string, string> = {
  data_breach: "💀",
  exposure: "🌐",
  phishing: "🎣",
  infrastructure: "🏗",
  privacy: "🔒",
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
