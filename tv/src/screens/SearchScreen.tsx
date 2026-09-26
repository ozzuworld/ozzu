import React, { useCallback, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  radius,
  screenPad,
  focus,
  withAlpha,
} from "../lib/theme";
import { FocusableButton } from "../components/FocusableButton";
import { Spinner } from "../components/States";
import { mediaResolve, mediaSearch, type SearchResult } from "../lib/bridge";

// Discover (broker lane, dir_1790443814736 P2): resolver search through the
// bridge (Prowlarr → ranked torrents), then stremio-server picks the file and
// the player streams straight from bridge-01. Nothing is stored; the marker is.

type Phase = "idle" | "searching" | "results";

export function SearchScreen() {
  const nav = useNavigation<any>();
  const [type, setType] = useState<"show" | "movie">("show");
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("1");
  const [episode, setEpisode] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<SearchResult | null>(null);
  const [resolveNote, setResolveNote] = useState<string | null>(null);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || resolving) return;
    setPhase("searching");
    setError(null);
    setResults([]);
    try {
      const out = await mediaSearch(q, type);
      setResults(out.results);
      setPhase(out.results.length ? "results" : "idle");
      if (!out.results.length) {
        setError("Nothing seedable found — try the exact title, or flip Series/Movies.");
      }
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message || "Search failed — is the bridge reachable?");
    }
  }, [query, type, resolving]);

  const play = useCallback(
    async (r: SearchResult) => {
      if (resolving) return;
      setResolving(r);
      setResolveNote(null);
      const opts =
        type === "movie"
          ? { movie: true }
          : {
              season: Math.max(1, parseInt(season, 10) || 1),
              episode: episode.trim() ? parseInt(episode, 10) || undefined : undefined,
            };
      try {
        let res = await mediaResolve(r.infoHash, opts);
        if (res.loading || !res.file || !res.stream) {
          setResolveNote("Torrent metadata still resolving — giving the swarm a few seconds…");
          await new Promise((ok) => setTimeout(ok, 8000));
          res = await mediaResolve(r.infoHash, opts);
        }
        if (!res.file || !res.stream) throw new Error(res.error || "Couldn't pick a playable file from this torrent");
        const s = parseInt(season, 10);
        const e = parseInt(episode, 10);
        nav.navigate("Player", {
          broker: {
            url: res.stream.lan,
            infoHash: r.infoHash,
            fileIdx: res.file.idx,
            fileName: res.file.path.split("/").pop() || undefined,
            title: query.trim(),
            season: type === "show" ? (Number.isFinite(s) ? Math.max(1, s) : 1) : undefined,
            episode: type === "show" && Number.isFinite(e) ? e : undefined,
            startSeconds: 0,
          },
        });
      } catch (e: any) {
        setError(e?.message || "Resolve failed — try another result.");
      } finally {
        setResolving(null);
        setResolveNote(null);
      }
    },
    [resolving, type, season, episode, query, nav]
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
        <Text style={styles.subtitle}>
          Straight from the swarm through your server — nothing is stored, your resume point is.
        </Text>
      </View>

      <View style={styles.controls}>
        <FocusableButton
          label="Series"
          primary={type === "show"}
          onPress={() => setType("show")}
          hasTVPreferredFocus={false}
        />
        <FocusableButton label="Movies" primary={type === "movie"} onPress={() => setType("movie")} />
        {type === "show" ? (
          <View style={styles.seRow}>
            <Text style={styles.seLabel}>S</Text>
            <TextInput
              style={styles.seInput}
              value={season}
              onChangeText={setSeason}
              keyboardType="number-pad"
              maxLength={2}
              focusable
            />
            <Text style={styles.seLabel}>E</Text>
            <TextInput
              style={styles.seInput}
              value={episode}
              onChangeText={setEpisode}
              keyboardType="number-pad"
              maxLength={3}
              placeholder="—"
              placeholderTextColor={colors.text.disabled}
              focusable
            />
          </View>
        ) : null}
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder={type === "show" ? "Search series… (S/E optional — needed for season packs)" : "Search movies…"}
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
        <FocusableButton label={phase === "searching" ? "Searching…" : "Search"} icon="⌕" primary onPress={doSearch} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {phase === "searching" ? (
        <Spinner label="Querying your indexers (1337x · EZTV · TPB · YTS)…" />
      ) : null}

      {phase === "results" ? (
        <FlatList
          data={results}
          keyExtractor={(r) => r.infoHash}
          contentContainerStyle={styles.list}
          initialNumToRender={6}
          renderItem={({ item, index }) => (
            <ResultRow item={item} onPress={() => play(item)} autoFocus={index === 0} />
          )}
        />
      ) : null}

      {resolving ? (
        <View style={styles.resolveOverlay}>
          <Spinner label={resolveNote || `Joining the swarm — picking the file from “${resolving.title.slice(0, 48)}”…`} />
        </View>
      ) : null}
    </View>
  );
}

// ── result row ───────────────────────────────────────────────────────────────

function ResultRow({
  item,
  onPress,
  autoFocus,
}: {
  item: SearchResult;
  onPress: () => void;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;

  const animate = (toScale: number, toRing: number) => {
    Animated.timing(scale, { toValue: toScale, duration: focus.tween, useNativeDriver: true }).start();
    Animated.timing(ring, { toValue: toRing, duration: focus.tween, useNativeDriver: true }).start();
  };

  return (
    <Pressable
      focusable
      hasTVPreferredFocus={autoFocus}
      onFocus={() => {
        setFocused(true);
        animate(1.015, 1);
      }}
      onBlur={() => {
        setFocused(false);
        animate(1, 0);
      }}
      onPress={onPress}
    >
      <Animated.View style={[styles.row, focused && styles.rowFocused, { transform: [{ scale }] }]}>
        <View style={styles.rowMain}>
          <Text style={[styles.rowTitle, focused && styles.rowTitleFocused]} numberOfLines={1}>
            {item.title}
          </Text>
          <View style={styles.pills}>
            <View style={[styles.pill, qualityPill(item.quality)]}>
              <Text style={styles.pillText}>{item.quality.toUpperCase()}</Text>
            </View>
            {item.seeders != null ? (
              <View style={[styles.pill, styles.pillSeed]}>
                <Text style={[styles.pillText, { color: colors.good }]}>▲ {item.seeders}</Text>
              </View>
            ) : null}
            {item.size ? (
              <View style={styles.pill}>
                <Text style={styles.pillText}>{fmtSize(item.size)}</Text>
              </View>
            ) : null}
            {item.indexer ? (
              <View style={styles.pill}>
                <Text style={[styles.pillText, { color: colors.text.tertiary }]}>{item.indexer}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <Text style={[styles.rowGo, focused && { color: colors.text.primary }]}>▶</Text>
        <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring }]} />
      </Animated.View>
    </Pressable>
  );
}

function qualityPill(q: string) {
  if (q === "1080p") return { backgroundColor: withAlpha(colors.good, 0.16) };
  if (q === "720p") return { backgroundColor: withAlpha(colors.text.secondary, 0.14) };
  if (q === "2160p") return { backgroundColor: withAlpha(colors.accent, 0.18) };
  return { backgroundColor: withAlpha(colors.text.disabled, 0.14) };
}

function fmtSize(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.base },
  header: { paddingHorizontal: screenPad, paddingTop: spacing.xl, paddingBottom: spacing.md },
  title: { color: colors.text.primary, fontSize: fontSize.h2, fontWeight: fontWeight.black },
  subtitle: { color: colors.text.tertiary, fontSize: fontSize.caption, marginTop: 4 },
  controls: {
    paddingHorizontal: screenPad,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  seRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginLeft: spacing.sm },
  seLabel: { color: colors.text.tertiary, fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  seInput: {
    width: 72,
    backgroundColor: withAlpha(colors.text.primary, 0.06),
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text.primary,
    fontSize: fontSize.caption,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    textAlign: "center",
  },
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
  error: {
    color: colors.accentBright,
    fontSize: fontSize.caption,
    paddingHorizontal: screenPad,
    marginBottom: spacing.sm,
  },
  list: { paddingHorizontal: screenPad, paddingBottom: spacing.xxxl, gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  rowFocused: { backgroundColor: colors.bg.surface },
  rowMain: { flex: 1, gap: spacing.xs },
  rowTitle: { color: colors.text.secondary, fontSize: fontSize.cardTitle + 1, fontWeight: fontWeight.medium },
  rowTitleFocused: { color: colors.text.primary, fontWeight: fontWeight.semibold },
  pills: { flexDirection: "row", gap: spacing.xs },
  pill: {
    borderRadius: radius.pill,
    backgroundColor: withAlpha(colors.text.primary, 0.08),
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pillSeed: { backgroundColor: withAlpha(colors.good, 0.12) },
  pillText: { color: colors.text.secondary, fontSize: fontSize.meta - 2, fontWeight: fontWeight.semibold },
  rowGo: { color: colors.text.disabled, fontSize: fontSize.body },
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: focus.ringWidth,
    borderColor: colors.focusRing,
    borderRadius: radius.lg,
  },
  resolveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg.scrim,
    justifyContent: "center",
    alignItems: "center",
  },
});
