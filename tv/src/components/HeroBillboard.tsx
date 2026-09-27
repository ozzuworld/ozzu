import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import {
  colors,
  hero,
  spacing,
  fontSize,
  fontWeight,
  screenPad,
  withAlpha,
  radius,
} from "../lib/theme";
import { FocusableButton } from "./FocusableButton";
import {
  tmdbBackdrop,
  yearFrom,
  isAvailable,
  type DiscoverItem,
} from "../lib/seerr";

// Netflix-style hero billboard: full-bleed TMDB backdrop, stacked scrims (no
// gradient lib in this package — same technique as DetailScreen), title +
// meta + overview bottom-left, Play/Request + More Info CTAs.

function Scrims() {
  return (
    <>
      {/* bottom fade into the page */}
      <View pointerEvents="none" style={[styles.scrimBand, { bottom: 0, height: 120, backgroundColor: withAlpha(colors.bg.base, 0.85) }]} />
      <View pointerEvents="none" style={[styles.scrimBand, { bottom: 120, height: 100, backgroundColor: withAlpha(colors.bg.base, 0.55) }]} />
      <View pointerEvents="none" style={[styles.scrimBand, { bottom: 220, height: 100, backgroundColor: withAlpha(colors.bg.base, 0.3) }]} />
      <View pointerEvents="none" style={[styles.scrimBand, { bottom: 320, height: 100, backgroundColor: withAlpha(colors.bg.base, 0.14) }]} />
      {/* left fade for text legibility */}
      <View pointerEvents="none" style={[styles.scrimLeft, { width: 900, backgroundColor: withAlpha(colors.bg.base, 0.3) }]} />
      <View pointerEvents="none" style={[styles.scrimLeft, { width: 620, backgroundColor: withAlpha(colors.bg.base, 0.25) }]} />
      {/* top fade so the brand header reads over the backdrop */}
      <View pointerEvents="none" style={[styles.scrimBand, { top: 0, height: 110, backgroundColor: withAlpha(colors.bg.base, 0.6) }]} />
    </>
  );
}

export function HeroBillboard({
  item,
  onPlay,
  onRequest,
  onMoreInfo,
  requestPending = false,
  requested = false,
  focusFirst = false,
}: {
  item: DiscoverItem;
  /** Present when playable now (availability.jellyfinId set). */
  onPlay?: () => void;
  /** Present when NOT in the library — Seerr request → auto-download pipeline. */
  onRequest?: () => void;
  onMoreInfo: () => void;
  requestPending?: boolean;
  requested?: boolean;
  focusFirst?: boolean;
}) {
  const backdrop = tmdbBackdrop(item.backdropPath || item.posterPath, "w1280");
  const year = yearFrom(item.releaseDate);
  const available = isAvailable(item.availability);

  const metaBits = [
    year,
    item.mediaType === "tv" ? "Series" : "Film",
    item.voteAverage ? `★ ${item.voteAverage.toFixed(1)}` : "",
  ].filter(Boolean);

  return (
    <View style={styles.root}>
      {backdrop ? (
        <Image source={{ uri: backdrop }} style={styles.backdrop} resizeMode="cover" />
      ) : (
        <View style={[styles.backdrop, styles.backdropFallback]} />
      )}
      <Scrims />

      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>

        <View style={styles.metaRow}>
          {available ? (
            <View style={styles.availablePill}>
              <Text style={styles.availableText}>IN LIBRARY</Text>
            </View>
          ) : requested ? (
            <View style={styles.requestedPill}>
              <Text style={styles.availableText}>REQUESTED</Text>
            </View>
          ) : null}
          <Text style={styles.meta}>{metaBits.join("  ·  ")}</Text>
        </View>

        {!!item.overview && (
          <Text style={styles.overview} numberOfLines={2}>
            {item.overview}
          </Text>
        )}

        <View style={styles.buttons}>
          {onPlay ? (
            <FocusableButton label="Play" icon="▶" primary onPress={onPlay} hasTVPreferredFocus={focusFirst} />
          ) : onRequest ? (
            <FocusableButton
              label={requestPending ? "Requesting…" : requested ? "Requested" : "Request"}
              icon="＋"
              onPress={requestPending || requested ? undefined : onRequest}
              hasTVPreferredFocus={focusFirst}
            />
          ) : null}
          <FocusableButton label="More Info" icon="ⓘ" onPress={onMoreInfo} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    height: hero.height,
    width: "100%",
    backgroundColor: colors.bg.elevated,
    overflow: "hidden",
  },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  backdropFallback: { backgroundColor: colors.bg.elevated },
  scrimBand: { position: "absolute", left: 0, right: 0 },
  scrimLeft: { position: "absolute", top: 0, bottom: 0, left: 0 },
  content: {
    position: "absolute",
    left: screenPad,
    right: screenPad,
    bottom: spacing.xxl,
    maxWidth: 1000,
  },
  title: {
    color: colors.text.primary,
    fontSize: fontSize.heroTitle,
    fontWeight: fontWeight.black,
    letterSpacing: 0.5,
    textShadowColor: colors.shadow,
    textShadowRadius: 12,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  meta: {
    color: colors.text.secondary,
    fontSize: fontSize.heroSub,
    fontWeight: fontWeight.medium,
  },
  availablePill: {
    backgroundColor: colors.good,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  requestedPill: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  availableText: {
    color: colors.bg.base,
    fontSize: fontSize.meta,
    fontWeight: fontWeight.black,
    letterSpacing: 1,
  },
  overview: {
    color: colors.text.secondary,
    fontSize: fontSize.body,
    marginTop: spacing.md,
    lineHeight: 27,
  },
  buttons: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg },
});
