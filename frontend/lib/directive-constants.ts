// Shared constants for directive components — single source of truth

export const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  planning: "🧠",
  planned: "📋",
  approved: "✅",
  in_progress: "🔨",
  completed: "🎉",
  failed: "❌",
  cancelled: "🚫",
  stale: "💤",
  blocked: "🛑",
  deploy_failed: "🚨",
};

export const STATUS_COLORS: Record<string, string> = {
  pending: "#737373",
  planning: "#A855F7",
  planned: "#8B5CF6",
  approved: "#FBBF24",
  in_progress: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  cancelled: "#F97316",
  stale: "#6B7280",
  blocked: "#F59E0B",
  deploy_failed: "#DC2626",
};

export const TYPE_EMOJI: Record<string, string> = {
  feature: "✨",
  quick: "⚡",
  explore: "🔍",
  epic: "📦",
};

export const PRIORITY_EMOJI: Record<number, string> = {
  1: "🔴",
  2: "🟠",
  3: "🟡",
  4: "⚪",
};

export const CATEGORY_INFO: Record<string, { label: string; emoji: string; color: string }> = {
  all: { label: "All", emoji: "🌍", color: "#06B6D4" },
  dev: { label: "Dev", emoji: "💻", color: "#3B82F6" },
  business: { label: "Business", emoji: "💼", color: "#F59E0B" },
  hardware: { label: "Hardware", emoji: "🔧", color: "#A855F7" },
  ops: { label: "Ops", emoji: "📡", color: "#22C55E" },
  planning: { label: "Planning", emoji: "📋", color: "#8B5CF6" },
};

export const HUMAN_STATUS: Record<string, string> = {
  pending: "Queued",
  planning: "Planning",
  planned: "Needs approval",
  approved: "Ready to start",
  in_progress: "In progress",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Stale",
  blocked: "Blocked",
  deploy_failed: "Deploy failed",
};

export const ACTOR_COLORS: Record<string, string> = {
  "King Kazuma": "#A78BFA",
  June: "#67E8F9",
  Cipher: "#6EE7B7",
  system: "#9CA3AF",
};

export const AUDIT_TYPE_EMOJIS: Record<string, string> = {
  status_change: "🔄",
  verification_started: "🔍",
  verification_success: "✅",
  verification_failure: "❌",
  completion_blocked: "🛑",
  build_triggered: "🏗️",
  deploy_started: "🚀",
  deploy_success: "✅",
  deploy_failed: "💥",
  comment: "💬",
  escalation: "⚡",
};

// Status groupings
export const ACTIVE_STATUSES = ["pending", "planning", "planned", "approved", "in_progress", "blocked"];
export const FAILED_STATUSES = ["failed", "stale", "deploy_failed"];
export const NEEDS_ACTION_STATUSES = ["planned", "blocked", "deploy_failed"];

// Sort order for status-based sorting
export const STATUS_ORDER: Record<string, number> = {
  deploy_failed: 0,
  blocked: 1,
  planned: 2,
  in_progress: 3,
  planning: 4,
  pending: 5,
  approved: 6,
  completed: 7,
  failed: 8,
  cancelled: 9,
  stale: 10,
};

// Valid status transitions (for StatusChangeSheet)
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["planning", "in_progress", "cancelled"],
  planning: ["planned", "in_progress", "cancelled"],
  planned: ["in_progress", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed", "failed", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  failed: ["pending", "cancelled"],
  stale: ["pending", "cancelled"],
  deploy_failed: ["pending", "in_progress", "cancelled"],
  cancelled: ["pending"],
};

export const TRANSITION_LABELS: Record<string, string> = {
  pending: "⏳ Reopen (Pending)",
  planning: "🧠 Start Planning",
  planned: "📋 Mark Planned",
  in_progress: "🔨 Start Work",
  completed: "🎉 Mark Completed",
  failed: "❌ Mark Failed",
  cancelled: "🚫 Cancel",
  blocked: "🛑 Mark Blocked",
};

// Helpers
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function humanDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function priorityLabel(p: number): string {
  if (p <= 1) return "P1";
  if (p <= 2) return "P2";
  if (p <= 3) return "P3";
  return "P4";
}
