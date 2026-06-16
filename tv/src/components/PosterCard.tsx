import React, { useRef, useState } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  colors,
  poster,
  radius,
  spacing,
  fontSize,
  fontWeight,
  focus,
  withAlpha,
} from "../lib/theme";
import { posterUrl } from "../lib/jellyfin/images";
import { watchedFraction, yearOf } from "../lib/format";
import { ProgressBar } from "./ProgressBar";

export function PosterCard({
  item,
  onPress,
  onFocus,
  hasTVPreferredFocus = false,
}: {
  item: BaseItemDto;
  onPress?: () => void;
  onFocus?: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;

  const uri = posterUrl(item);
  const progress = watchedFraction(item);
  const title = item.Name ?? "";
  const sub = item.Type === "Episode" ? item.SeriesName ?? "" : yearOf(item);

  const animate = (toScale: number, toRing: number) => {
    Animated.timing(scale, {
      toValue: toScale,
      duration: focus.tween,
      useNativeDriver: true,
    }).start();
    Animated.timing(ring, {
      toValue: toRing,
      duration: focus.tween,
      useNativeDriver: true,
    }).start();
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
                {title}
              </Text>
            </View>
          )}
          {progress > 0 ? (
            <ProgressBar fraction={progress} height={4} style={styles.progress} />
          ) : null}
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring }]} />
        </View>
        <Text style={[styles.title, focused && styles.titleFocused]} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text style={styles.sub} numberOfLines={1}>
            {sub}
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
  progress: { position: "absolute", left: spacing.sm, right: spacing.sm, bottom: spacing.sm },
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
