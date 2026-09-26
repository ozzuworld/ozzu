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
import { brokerStreamLan, markersContinue, type Marker } from "../lib/bridge";
import { colors, spacing, fontSize, fontWeight, screenPad } from "../lib/theme";
import { MediaRail } from "../components/MediaRail";
import { MarkerRail } from "../components/MarkerRail";
import { FocusableButton } from "../components/FocusableButton";
import { ErrorView, Spinner } from "../components/States";

interface Rail {
  key: string;
  title: string;
  items: BaseItemDto[];
}

// Home = two lanes (dir_1790443814736 P2):
//   Ozzu broker rail  — postgres markers, independent of Jellyfin (works even
//                       if the library server is down; streams from stremio-server)
//   Jellyfin rails    — rotation library (Continue Watching / Recently Added / libs)

async function loadJellyfinRails(userId: string): Promise<Rail[]> {
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
  return out;
}

export function HomeScreen() {
  const nav = useNavigation<any>();
  const [rails, setRails] = useState<Rail[] | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const yPos = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    setError(null);
    setRails(null);
    const userId = getUserId();
    // The broker lane never depends on Jellyfin being up (and vice versa).
    const [jf, mk] = await Promise.allSettled([
      loadJellyfinRails(userId),
      markersContinue().then((r) => r.markers),
    ]);
    setMarkers(mk.status === "fulfilled" ? mk.value : []);
    if (jf.status === "fulfilled") {
      setRails(jf.value);
    } else if (mk.status !== "fulfilled") {
      setError("Couldn't reach your Jellyfin server or the Ozzu bridge.");
    } else {
      setRails([]);
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

  const openMarker = (m: Marker) => {
    const dur = m.duration_seconds || 0;
    const nearEnd = dur > 0 && m.position_seconds / dur > 0.98;
    nav.navigate("Player", {
      broker: {
        url: brokerStreamLan(m.info_hash, m.file_idx),
        infoHash: m.info_hash,
        fileIdx: m.file_idx,
        fileName: m.file_name || undefined,
        title: m.title,
        season: m.season ?? undefined,
        episode: m.episode ?? undefined,
        startSeconds: nearEnd ? 0 : m.position_seconds,
      },
    });
  };

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!rails) return <Spinner label="Loading your library…" />;
  if (!rails.length && !markers.length)
    return <ErrorView message="No media found — try Discover, or add libraries in Jellyfin." onRetry={load} />;

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
          <FocusableButton label="Discover" icon="⌕" onPress={() => nav.navigate("Search")} />
        </View>

        {markers.length ? (
          <View
            onLayout={(e) => {
              yPos.current["broker"] = e.nativeEvent.layout.y;
            }}
          >
            <MarkerRail
              title="Continue Watching — Ozzu"
              markers={markers}
              firstItemFocus
              onSelect={openMarker}
              onRowFocus={() => onRowFocus("broker")}
            />
          </View>
        ) : null}

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
              firstItemFocus={i === 0 && !markers.length}
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
  header: {
    paddingHorizontal: screenPad,
    marginBottom: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    color: colors.text.primary,
    fontSize: fontSize.brand,
    fontWeight: fontWeight.black,
    letterSpacing: 2,
  },
  brandAccent: { color: colors.accent },
});
