import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  getContinueWatching,
  getItemsInView,
  getLatest,
  getLibraries,
} from "../lib/jellyfin/home";
import { getUserId } from "../lib/jellyfin/client";
import { colors, spacing, fontSize, fontWeight, screenPad } from "../lib/theme";
import { MediaRail } from "../components/MediaRail";
import { ErrorView, Spinner } from "../components/States";

interface Rail {
  key: string;
  title: string;
  items: BaseItemDto[];
}

export function HomeScreen() {
  const nav = useNavigation<any>();
  const [rails, setRails] = useState<Rail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const yPos = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    setError(null);
    setRails(null);
    try {
      const userId = getUserId();
      const [resume, libraries] = await Promise.all([
        getContinueWatching(userId),
        getLibraries(userId),
      ]);
      const out: Rail[] = [];
      if (resume.length) out.push({ key: "resume", title: "Continue Watching", items: resume });

      const latest = await getLatest(userId);
      if (latest.length) out.push({ key: "latest", title: "Recently Added", items: latest });

      const videoLibs = libraries.filter(
        (l) => l.collectionType === "movies" || l.collectionType === "tvshows"
      );
      const libItems = await Promise.all(videoLibs.map((l) => getItemsInView(userId, l.id)));
      videoLibs.forEach((l, i) => {
        if (libItems[i]?.length) out.push({ key: `lib-${l.id}`, title: l.name, items: libItems[i] });
      });

      setRails(out);
    } catch {
      setError("Couldn't reach your Jellyfin server.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRowFocus = (key: string) => {
    const y = yPos.current[key] ?? 0;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.xxl), animated: true });
  };

  const openDetail = (item: BaseItemDto) => {
    if (item.Id) nav.navigate("Detail", { itemId: item.Id });
  };

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!rails) return <Spinner label="Loading your library…" />;
  if (!rails.length)
    return <ErrorView message="No media found in your libraries yet." onRetry={load} />;

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        <View style={styles.header}>
          <Text style={styles.brand}>
            OZZU<Text style={styles.brandAccent}> TV</Text>
          </Text>
        </View>
        {rails.map((r, i) => (
          <View
            key={r.key}
            onLayout={(e) => {
              yPos.current[r.key] = e.nativeEvent.layout.y;
            }}
          >
            <MediaRail
              title={r.title}
              items={r.items}
              firstItemFocus={i === 0}
              onSelect={openDetail}
              onRowFocus={() => onRowFocus(r.key)}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.base },
  scroll: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  header: { paddingHorizontal: screenPad, marginBottom: spacing.lg },
  brand: {
    color: colors.text.primary,
    fontSize: fontSize.brand,
    fontWeight: fontWeight.black,
    letterSpacing: 2,
  },
  brandAccent: { color: colors.accent },
});
