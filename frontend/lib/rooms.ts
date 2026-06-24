export type Rarity = "legendary" | "epic" | "rare" | "common";

export const RARITY_COLORS: Record<
  Rarity,
  { border: string; glow: string; bg: string; text: string; dim: string }
> = {
  legendary: {
    border: "#F59E0B",
    glow: "#F59E0B",
    bg: "rgba(245,158,11,0.12)",
    text: "#FCD34D",
    dim: "rgba(245,158,11,0.06)",
  },
  epic: {
    border: "#A855F7",
    glow: "#A855F7",
    bg: "rgba(168,85,247,0.12)",
    text: "#C084FC",
    dim: "rgba(168,85,247,0.06)",
  },
  rare: {
    border: "#3B82F6",
    glow: "#3B82F6",
    bg: "rgba(59,130,246,0.12)",
    text: "#93C5FD",
    dim: "rgba(59,130,246,0.06)",
  },
  common: {
    border: "#525252",
    glow: "transparent",
    bg: "rgba(82,82,82,0.12)",
    text: "#A3A3A3",
    dim: "rgba(82,82,82,0.06)",
  },
};
