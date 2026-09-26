import React, { useEffect, useState } from "react";
import { Image, ImageBackground, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getItemDetail } from "../lib/jellyfin/items";
import { getUserId } from "../lib/jellyfin/client";
import { backdropUrl, logoUrl } from "../lib/jellyfin/images";
import { formatRuntime, ticksToSeconds, yearOf } from "../lib/format";
import { colors, spacing, fontSize, fontWeight, screenPad, withAlpha } from "../lib/theme";
import { FocusableButton } from "../components/FocusableButton";
import { ErrorView, Spinner } from "../components/States";

export function DetailScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const itemId: string = route.params?.itemId;
  const [item, setItem] = useState<BaseItemDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const it = await getItemDetail(getUserId(), itemId);
        if (alive) setItem(it);
      } catch {
        if (alive) setError("Couldn't load this title.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [itemId]);

  if (error) return <ErrorView message={error} onRetry={() => nav.goBack()} />;
  if (!item) return <Spinner label="Loading…" />;

  const backdrop = backdropUrl(item);
  const logo = logoUrl(item);
  const resumeSeconds = ticksToSeconds(item.UserData?.PlaybackPositionTicks || 0);
  const canResume = resumeSeconds > 1;
  const meta = [yearOf(item), formatRuntime(item.RunTimeTicks), item.OfficialRating || ""]
    .filter(Boolean)
    .join("   •   ");

  const play = (fromStart: boolean) =>
    nav.navigate("Player", { itemId, startSeconds: fromStart ? 0 : resumeSeconds });

  const body = (
    <View style={styles.content}>
      {logo ? (
        <Image source={{ uri: logo }} style={styles.logo} resizeMode="contain" />
      ) : (
        <Text style={styles.title} numberOfLines={2}>
          {item.Name}
        </Text>
      )}
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      {item.Overview ? (
        <Text style={styles.overview} numberOfLines={4}>
          {item.Overview}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {canResume ? (
          <FocusableButton label="Resume" icon="▶" primary hasTVPreferredFocus onPress={() => play(false)} />
        ) : null}
        <FocusableButton
          label={canResume ? "Play from start" : "Play"}
          icon={canResume ? undefined : "▶"}
          primary={!canResume}
          hasTVPreferredFocus={!canResume}
          onPress={() => play(true)}
        />
      </View>
    </View>
  );

  if (!backdrop) {
    return <View style={[styles.root, { backgroundColor: colors.bg.base }]}>{body}</View>;
  }
  return (
    <ImageBackground source={{ uri: backdrop }} style={styles.root}>
      <View style={styles.scrimLeft} />
      <View style={styles.scrimBottom} />
      {body}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.bg.base },
  scrimLeft: { ...StyleSheet.absoluteFillObject, backgroundColor: withAlpha(colors.bg.base, 0.55) },
  scrimBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "60%",
    backgroundColor: withAlpha(colors.bg.base, 0.45),
  },
  content: { padding: screenPad, paddingBottom: spacing.xxl, maxWidth: 980 },
  logo: { width: 360, height: 130, marginBottom: spacing.md },
  title: {
    color: colors.text.primary,
    fontSize: fontSize.heroTitle,
    fontWeight: fontWeight.black,
    marginBottom: spacing.sm,
  },
  meta: { color: colors.text.secondary, fontSize: fontSize.caption, marginBottom: spacing.md },
  overview: {
    color: colors.text.secondary,
    fontSize: fontSize.body,
    lineHeight: fontSize.body * 1.4,
    marginBottom: spacing.xl,
  },
  actions: { flexDirection: "row", gap: spacing.md },
});
