// Design tokens — single source of truth for all UI styling.
// Accent palette switched from Linear indigo to codebase-actual cyan (dir_1779034939863, 2026-05-17).

// ── Colors ──

export const colors = {
  // Base surfaces (luminance-based elevation: lighter = higher)
  bg: {
    base: "#0a0a0a",
    elevated: "#161617",
    surface: "#1e1f20",
    overlay: "#262728",
  },

  // Text
  text: {
    primary: "#ebebeb",
    secondary: "#9b9b9b",
    tertiary: "#6b6b6b",
    disabled: "#454545",
  },

  // Accent — cyan (was Linear indigo until 2026-05-17)
  accent: "#06B6D4",
  accentLight: "#22d3ee",

  // Brand colors used across the app
  brand: {
    cyan: "#06B6D4",         // accent (alias)
    cyanLight: "#22d3ee",
    spotify: "#1DB954",      // music tab
    purple: "#A855F7",
    blue: "#3B82F6",
    amber: "#F59E0B",
    amberDeep: "#EAB308",
    orange: "#F97316",
  },

  // Gray scale (mapped to the actual hexes the codebase has been using)
  gray: {
    50:  "#e5e5e5",   // ultra-light text on dark
    100: "#cbd5e1",   // slate
    200: "#a3a3a3",   // light text
    250: "#94a3b8",   // mid slate
    300: "#737373",   // mid text
    400: "#525252",   // dim text
    500: "#404040",   // dim border
    600: "#333333",   // border
    700: "#2a2a2a",   // surface (low)
    800: "#1a1a1a",   // surface (mid)
    850: "#111111",   // surface (deep)
    900: "#0a0a0a",   // base bg (alias of colors.bg.base)
  },

  // Borders
  border: {
    subtle: "#1e1f20",
    default: "#2e2f30",
    strong: "#3e3f40",
  },

  // Status colors
  status: {
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
  } as Record<string, string>,

  // Semantic
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  info: "#3B82F6",
} as const;

// ── Spacing (8pt grid) ──

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

// ── Layout ──

export const layout = {
  topBarHeight: 48,
} as const;

// ── Border Radius ──

export const radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 999,
} as const;

// ── Typography ──

export const fontSize = {
  xs: 10,
  sm: 11,
  md: 12,
  base: 13,
  lg: 14,
  xl: 16,
  xxl: 18,
  title: 22,
} as const;

export const fontWeight = {
  normal: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
};

// ── Helpers ──

export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

export function statusPillStyle(status: string): {
  bg: string;
  text: string;
  dot: string;
} {
  const color = colors.status[status] || "#737373";
  return {
    bg: withAlpha(color, 0.12),
    text: color,
    dot: color,
  };
}

// Actor colors for timeline
export const actorColors: Record<string, string> = {
  "King Kazuma": "#A78BFA",
  June: "#67E8F9",
  Cipher: "#6EE7B7",
  system: "#9CA3AF",
};

// Audit type colors for timeline dots
export const auditTypeColors: Record<string, string> = {
  status_change: "#3B82F6",
  verification_started: "#A855F7",
  verification_success: "#22C55E",
  verification_failure: "#EF4444",
  completion_blocked: "#F59E0B",
  build_triggered: "#3B82F6",
  deploy_started: "#06B6D4",
  deploy_success: "#22C55E",
  deploy_failed: "#EF4444",
  comment: "#9b9b9b",
  escalation: "#F59E0B",
  commit: "#5e6ad2",
  work_update: "#3B82F6",
  session_handoff: "#A855F7",
  merged: "#22C55E",
  ci_build: "#3B82F6",
  agent_status: "#6EE7B7",
};
