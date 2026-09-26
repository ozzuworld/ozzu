// Ozzu TV — 10-foot design system for the Netflix-style media client.
//
// Seeded from frontend/lib/design-tokens.ts but TV-scaled (larger type, generous
// spacing) and given a cinematic dark + Netflix-red identity. tv/ is a separate
// package and CANNOT import from frontend/, so this file is the single source of
// truth for the TV app's styling.
//
// RULE: components NEVER inline hex / magic numbers — pull everything from here.

import type { TextStyle } from "react-native";

export const colors = {
  // Cinematic near-black base (Netflix sits ~#141414; we go a touch deeper/cooler).
  bg: {
    base: "#0b0b0f", // app background
    elevated: "#16161c", // cards / surfaces (one step up)
    surface: "#202028", // raised surface / pressed
    scrim: "rgba(0,0,0,0.60)", // overlay on backdrops
  },
  text: {
    primary: "#f5f5f7",
    secondary: "#b9b9c0",
    tertiary: "#80808a",
    disabled: "#4c4c55",
    onAccent: "#ffffff",
    onLight: "#0b0b0f", // text on the white Play button
  },
  // Netflix-red brand accent — primary CTA + progress + brand mark.
  accent: "#e50914",
  accentBright: "#f6121d",
  // The "selected" affordance on TV reads best as a bright white ring.
  focusRing: "#ffffff",
  // Jellyfin "community rating" / progress green (Netflix match-green vibe).
  good: "#46d369",
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.24)",
  shadow: "#000000",
} as const;

// 8pt-ish rhythm, scaled up for the couch.
export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 18,
  pill: 999,
} as const;

// 10-foot type scale — meaningfully larger than a phone.
export const fontSize = {
  meta: 15,
  caption: 16,
  body: 19,
  cardTitle: 17,
  railTitle: 25,
  h2: 32,
  heroSub: 22,
  heroTitle: 54,
  brand: 30,
} as const;

export const fontWeight: Record<
  "regular" | "medium" | "semibold" | "bold" | "black",
  TextStyle["fontWeight"]
> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  black: "800",
};

// Screen-edge gutter (Netflix uses ~58px on a 1080p TV).
export const screenPad = 56;

// Poster geometry (2:3). ~7 visible per row at 1920w with the gutter.
export const poster = {
  width: 218,
  height: 327,
  gap: 18,
  focusScale: 1.1,
  radius: radius.md,
} as const;

// Backdrop thumbnails (16:9) for Continue Watching rows.
export const thumb = {
  width: 380,
  height: 214,
  gap: 18,
  focusScale: 1.06,
  radius: radius.md,
} as const;

// Hero billboard (Phase 2).
export const hero = {
  height: 640,
} as const;

// Focus visuals shared by all focusable tiles/buttons.
export const focus = {
  ringWidth: 4,
  // duration of the scale/opacity tween (ms)
  tween: 120,
} as const;

/** #rrggbb + alpha(0..1) -> #rrggbbaa */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
