import React, { useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import type { Marker } from "../lib/bridge";
import { colors, thumb, spacing, fontSize, fontWeight, radius, focus } from "../lib/theme";
import { formatTime } from "../lib/format";
import { ProgressBar } from "./ProgressBar";

/** Continue-watching card for the broker lane (no Jellyfin item behind it —
 * the marker row IS the source of truth). 16:9 thumb geometry, focus ring +
 * scale, resume position bar. (dir_1790443814736 P2) */
export function MarkerCard({
  marker,
  onPress,
  hasTVPreferredFocus = false,
  onFocus,
}: {
  marker: Marker;
  onPress?: () => void;
  hasTVPreferredFocus?: boolean;
  onFocus?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;

  const ep = marker.season != null && marker.episode != null
    ? `S${String(marker.season).padStart(2, "0")}E${String(marker.episode).padStart(2, "0")}`
    : marker.kind === "movie" ? "Movie" : "";
  const dur = marker.duration_seconds || 0;
  const fraction = dur > 0 ? Math.min(1, marker.position_seconds / dur) : 0;
  const when = timeAgo(marker.updated_at);

  const animate = (toScale: number, toRing: number) => {
    Animated.timing(scale, { toValue: toScale, duration: focus.tween, useNativeDriver: true }).start();
    Animated.timing(ring, { toValue: toRing, duration: focus.tween, useNativeDriver: true }).start();
  };

  return (
    <Pressable
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => {
        setFocused(true);
        animate(thumb.focusScale, 1);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        animate(1, 0);
      }}
      onPress={onPress}
    >
      <Animated.View style={[styles.card, { transform: [{ scale }] }]}>
        <View style={styles.thumbWrap}>
          <View style={styles.thumbInner}>
            <Text style={styles.badge}>OZZU</Text>
            <Text style={[styles.cardTitle, focused && styles.cardTitleFocused]} numberOfLines={2}>
              {marker.title}
            </Text>
            {ep ? <Text style={styles.ep}>{ep}</Text> : null}
          </View>
          {fraction > 0 ? <ProgressBar fraction={fraction} height={5} style={styles.progress} /> : null}
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring }]} />
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {formatTime(marker.position_seconds)} in{dur > 0 ? ` / ${formatTime(dur)}` : ""}   •   {when}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const styles = StyleSheet.create({
  card: { width: thumb.width },
  thumbWrap: {
    width: thumb.width,
    height: thumb.height,
    borderRadius: thumb.radius,
    overflow: "hidden",
    backgroundColor: colors.bg.elevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumbInner: { flex: 1, justifyContent: "center", padding: spacing.md, gap: 4 },
  badge: {
    alignSelf: "flex-start",
    color: colors.text.onAccent,
    backgroundColor: colors.accent,
    fontSize: 11,
    fontWeight: fontWeight.black,
    letterSpacing: 1.5,
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },
  cardTitle: {
    color: colors.text.secondary,
    fontSize: fontSize.cardTitle + 2,
    fontWeight: fontWeight.semibold,
  },
  cardTitleFocused: { color: colors.text.primary },
  ep: { color: colors.text.tertiary, fontSize: fontSize.meta, marginTop: 2 },
  progress: { position: "absolute", left: spacing.sm, right: spacing.sm, bottom: spacing.sm },
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: focus.ringWidth,
    borderColor: colors.focusRing,
    borderRadius: thumb.radius,
  },
  meta: {
    width: thumb.width,
    color: colors.text.disabled,
    fontSize: fontSize.meta - 2,
    marginTop: spacing.sm,
  },
});
