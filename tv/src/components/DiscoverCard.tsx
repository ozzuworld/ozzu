import React, { useRef, useState } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  colors,
  poster,
  radius,
  spacing,
  fontSize,
  fontWeight,
  focus,
} from "../lib/theme";
import { tmdbPoster, yearFrom, isAvailable, type DiscoverItem } from "../lib/seerr";

/**
 * Discovery poster card (TMDB artwork via the Seerr lane) — the sibling of
 * PosterCard (Jellyfin artwork) for catalog rows: Trending, More Like This,
 * search results. Availability badge: green ✓ pill when the library already
 * holds it (Seerr MediaStatus 4/5 → playable through Jellyfin).
 */
export function DiscoverCard({
  item,
  onPress,
  onFocus,
  hasTVPreferredFocus = false,
}: {
  item: DiscoverItem;
  onPress?: () => void;
  onFocus?: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;

  const uri = tmdbPoster(item.posterPath);
  const year = yearFrom(item.releaseDate);
  const available = isAvailable(item.availability);

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
        animate(poster.focusScale, 1);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        animate(1, 0);
      }}
      onPress={onPress}
    >
      <Animated.View style={[styles.card, { transform: [{ scale }] }]}>
        <View style={styles.posterWrap}>
          {uri ? (
            <Image source={{ uri }} style={styles.poster} resizeMode="cover" />
          ) : (
            <View style={[styles.poster, styles.placeholder]}>
              <Text style={styles.placeholderText} numberOfLines={4}>
                {item.title}
              </Text>
            </View>
          )}
          {available ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>✓</Text>
            </View>
          ) : null}
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring }]} />
        </View>
        <Text style={[styles.title, focused && styles.titleFocused]} numberOfLines={1}>
          {item.title}
        </Text>
        {year ? (
          <Text style={styles.sub} numberOfLines={1}>
            {year}
            {item.voteAverage ? `  ·  ★ ${item.voteAverage.toFixed(1)}` : ""}
          </Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: poster.width },
  posterWrap: {
    width: poster.width,
    height: poster.height,
    borderRadius: poster.radius,
    overflow: "hidden",
    backgroundColor: colors.bg.elevated,
  },
  poster: { width: "100%", height: "100%" },
  placeholder: { alignItems: "center", justifyContent: "center", padding: spacing.md },
  placeholderText: {
    color: colors.text.tertiary,
    fontSize: fontSize.cardTitle,
    fontWeight: fontWeight.semibold,
    textAlign: "center",
  },
  badge: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.good,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: colors.bg.base, fontSize: fontSize.caption, fontWeight: fontWeight.black },
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: focus.ringWidth,
    borderColor: colors.focusRing,
    borderRadius: poster.radius,
  },
  title: {
    width: poster.width,
    marginTop: spacing.sm,
    color: colors.text.tertiary,
    fontSize: fontSize.cardTitle,
    fontWeight: fontWeight.medium,
  },
  titleFocused: { color: colors.text.primary },
  sub: {
    width: poster.width,
    color: colors.text.disabled,
    fontSize: fontSize.meta,
    marginTop: 2,
  },
});
