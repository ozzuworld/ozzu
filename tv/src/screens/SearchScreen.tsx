import React, { useCallback, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  radius,
  screenPad,
  poster,
  withAlpha,
} from "../lib/theme";
import { FocusableButton } from "../components/FocusableButton";
import { Spinner } from "../components/States";
import { DiscoverCard } from "../components/DiscoverCard";
import { discoverSearch, type DiscoverItem } from "../lib/seerr";

// Search = the Seerr/TMDB catalog lane (KK 2026-10-02: "everything on the
// frontend is jellyseerr — search, images, all of it"). Posters, metadata and
// the green ✓ availability pill come from Seerr; picking a card opens
// DiscoverDetail, whose Watch button orchestrates request → download →
// Jellyfin import → auto-play. The old indexer/broker search rows were
// REPLACED by this lane; the broker resume rail lives on at Home (markers).

type Phase = "idle" | "searching" | "results";
type Filter = "all" | "tv" | "movie";

// 7 × 218 poster + 6 × 18 gap = 1634 ≤ 1920 − 2·screenPad(56) = 1808
const COLS = 7;

export function SearchScreen() {
  const nav = useNavigation<any>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<DiscoverItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setPhase("searching");
    setError(null);
    try {
      const out = await discoverSearch(q);
      setResults(out.results);
      setPhase("results");
      if (!out.results.length) {
        setError(`Nothing titled “${q}” in the catalog — try a shorter or exact name.`);
      }
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message || "Search failed — is the bridge reachable?");
    }
  }, [query]);

  const shown = filter === "all" ? results : results.filter((r) => r.mediaType === filter);

  const open = (item: DiscoverItem) =>
    nav.navigate("DiscoverDetail", { tmdbId: item.tmdbId, mediaType: item.mediaType });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Search</Text>
        <Text style={styles.subtitle}>
          The whole catalog — press Watch and it downloads itself into your library.
        </Text>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Series or movies — anything in the catalog…"
          placeholderTextColor={colors.text.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={doSearch}
          returnKeyType="search"
          hasTVPreferredFocus
          focusable
        />
        <FocusableButton
          label={phase === "searching" ? "Searching…" : "Search"}
          icon="⌕"
          primary
          onPress={doSearch}
        />
      </View>

      {phase === "results" ? (
        <View style={styles.filters}>
          <FocusableButton label="All" primary={filter === "all"} onPress={() => setFilter("all")} />
          <FocusableButton label="Series" primary={filter === "tv"} onPress={() => setFilter("tv")} />
          <FocusableButton label="Movies" primary={filter === "movie"} onPress={() => setFilter("movie")} />
          <Text style={styles.count}>
            {shown.length} result{shown.length === 1 ? "" : "s"}
          </Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {phase === "searching" ? <Spinner label="Searching the catalog…" /> : null}

      {phase === "results" && shown.length ? (
        <FlatList
          data={shown}
          keyExtractor={(r) => `${r.mediaType}-${r.tmdbId}`}
          numColumns={COLS}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          initialNumToRender={COLS * 2}
          windowSize={5}
          renderItem={({ item, index }) => (
            <DiscoverCard
              item={item}
              onPress={() => open(item)}
              hasTVPreferredFocus={index === 0}
            />
          )}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.base },
  header: { paddingHorizontal: screenPad, paddingTop: spacing.xl, paddingBottom: spacing.md },
  title: { color: colors.text.primary, fontSize: fontSize.h2, fontWeight: fontWeight.black },
  subtitle: { color: colors.text.tertiary, fontSize: fontSize.caption, marginTop: 4 },
  searchRow: {
    paddingHorizontal: screenPad,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  input: {
    flex: 1,
    backgroundColor: withAlpha(colors.text.primary, 0.06),
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text.primary,
    fontSize: fontSize.body,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  filters: {
    paddingHorizontal: screenPad,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  count: { color: colors.text.disabled, fontSize: fontSize.meta, marginLeft: spacing.sm },
  error: {
    color: colors.accentBright,
    fontSize: fontSize.caption,
    paddingHorizontal: screenPad,
    marginBottom: spacing.sm,
  },
  grid: { paddingHorizontal: screenPad, paddingBottom: spacing.xxxl },
  gridRow: { gap: poster.gap, marginBottom: poster.gap },
});
