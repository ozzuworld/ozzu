import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../navigation/routes";
import {
  colors,
  radius,
  spacing,
  fontSize,
  fontWeight,
  screenPad,
  withAlpha,
  focus as focusTokens,
} from "../lib/theme";
import { FocusableButton } from "../components/FocusableButton";
import { DiscoverRail } from "../components/DiscoverRail";
import { ErrorView, Spinner } from "../components/States";
import {
  discoverDetail,
  submitRequest,
  tmdbBackdrop,
  tmdbPoster,
  tmdbProfile,
  yearFrom,
  isAvailable,
  type CastMember,
  type DiscoverDetail,
  type DiscoverItem,
  type DiscoverMediaType,
} from "../lib/seerr";
import { authHeaders, getBaseUrl, getUserId } from "../lib/jellyfin/client";
import { formatRuntime, ticksToSeconds } from "../lib/format";

// Discovery detail (Seerr lane) — the TMDB catalog counterpart of DetailScreen
// (Jellyfin lane). Seerr provides the metadata + availability + request flow;
// when the title is IN the library (availability.jellyfinId), playback goes
// straight through Jellyfin: movies → Player, series → season/episode picker
// (raw JF /Shows endpoints, header auth — the SDK's tvApi omits them).

interface JfSeason {
  Id: string;
  Name?: string;
  IndexNumber?: number;
}

interface JfEpisode {
  Id: string;
  Name?: string;
  IndexNumber?: number;
  Overview?: string;
  RunTimeTicks?: number;
  ImageTags?: Record<string, string>;
}

async function jfGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function epThumbUrl(ep: JfEpisode): string | null {
  if (!ep.ImageTags?.Primary) return null;
  return `${getBaseUrl()}/Items/${ep.Id}/Images/Primary?fillWidth=320`;
}

function CastCard({ member }: { member: CastMember }) {
  const uri = tmdbProfile(member.profilePath);
  return (
    <View style={castStyles.card}>
      {uri ? (
        <Image source={{ uri }} style={castStyles.face} resizeMode="cover" />
      ) : (
        <View style={[castStyles.face, castStyles.faceFallback]}>
          <Text style={castStyles.faceInitial}>{member.name.slice(0, 1)}</Text>
        </View>
      )}
      <Text style={castStyles.name} numberOfLines={1}>
        {member.name}
      </Text>
      <Text style={castStyles.character} numberOfLines={2}>
        {member.character}
      </Text>
    </View>
  );
}

const castStyles = StyleSheet.create({
  card: { width: 150, marginRight: spacing.md },
  face: {
    width: 150,
    height: 150,
    borderRadius: radius.pill,
    backgroundColor: colors.bg.elevated,
  },
  faceFallback: { alignItems: "center", justifyContent: "center" },
  faceInitial: { color: colors.text.tertiary, fontSize: fontSize.h2, fontWeight: fontWeight.bold },
  name: {
    color: colors.text.primary,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
  },
  character: { color: colors.text.tertiary, fontSize: fontSize.meta, marginTop: 2 },
});

export function DiscoverDetailScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, "DiscoverDetail">>();
  const { tmdbId, mediaType } = route.params;

  const [detail, setDetail] = useState<DiscoverDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // request state (Seerr → Sonarr/Radarr → library)
  const [reqPending, setReqPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [reqNote, setReqNote] = useState<string | null>(null);

  // Jellyfin episode browser (series that are already in the library)
  const [seasons, setSeasons] = useState<JfSeason[]>([]);
  const [activeSeason, setActiveSeason] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<JfEpisode[]>([]);
  const [epError, setEpError] = useState<string | null>(null);

  const jellyfinId = detail?.availability?.jellyfinId ?? null;
  const available = isAvailable(detail?.availability);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await discoverDetail(tmdbId, mediaType as DiscoverMediaType);
      setDetail(d);
      setRequested(d.availability?.requested ?? false);
    } catch (e: any) {
      setError(e?.message || "Couldn't load details.");
    }
  }, [tmdbId, mediaType]);

  useEffect(() => {
    load();
  }, [load]);

  // seasons list once we know the Jellyfin series id
  useEffect(() => {
    if (!jellyfinId || mediaType !== "tv" || !getUserId()) return;
    (async () => {
      try {
        const d = await jfGet<{ Items: JfSeason[] }>(
          `/Shows/${jellyfinId}/Seasons?userId=${getUserId()}`
        );
        const list = (d.Items || []).filter((s) => (s.IndexNumber ?? 1) >= 1);
        setSeasons(list);
        if (list.length) setActiveSeason(list[0].Id);
      } catch (e: any) {
        setEpError(e?.message || "Couldn't load seasons from Jellyfin.");
      }
    })();
  }, [jellyfinId, mediaType]);

  // episodes for the picked season
  useEffect(() => {
    if (!jellyfinId || !activeSeason || !getUserId()) return;
    setEpisodes([]);
    setEpError(null);
    (async () => {
      try {
        const d = await jfGet<{ Items: JfEpisode[] }>(
          `/Shows/${jellyfinId}/Episodes?userId=${getUserId()}&seasonId=${activeSeason}&fields=Overview,RuntimeTicks&limit=200`
        );
        setEpisodes(d.Items || []);
      } catch (e: any) {
        setEpError(e?.message || "Couldn't load episodes from Jellyfin.");
      }
    })();
  }, [jellyfinId, activeSeason]);

  const doRequest = async () => {
    if (!detail || reqPending) return;
    setReqPending(true);
    setReqNote(null);
    try {
      const r = await submitRequest(detail.tmdbId, detail.mediaType, "all");
      if (r.created) {
        setRequested(true);
        setReqNote("Requested — Seerr handed it to the download pipeline. It appears here when Jellyfin imports it.");
      } else if (r.reason === "nothing_to_request") {
        setReqNote(r.message || "Nothing left to request — already in your library.");
      } else if (r.reason === "duplicate") {
        setRequested(true);
        setReqNote("Already requested — it's in the pipeline.");
      } else {
        setReqNote(r.message || "Request accepted.");
      }
    } catch (e: any) {
      setReqNote(`Request failed: ${e?.message || "unknown error"}`);
    } finally {
      setReqPending(false);
    }
  };

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!detail) return <Spinner label="Loading details…" />;

  const year = yearFrom(detail.releaseDate || detail.firstAirDate);
  const runtimeLabel =
    mediaType === "movie"
      ? detail.runtime
        ? `${Math.floor(detail.runtime / 60)}h ${detail.runtime % 60}m`
        : ""
      : detail.showStatus || "";
  const metaBits = [
    year,
    mediaType === "tv" ? "Series" : "Film",
    runtimeLabel,
    detail.voteAverage ? `★ ${detail.voteAverage.toFixed(1)}` : "",
  ].filter(Boolean);
  const moreLike: DiscoverItem[] = detail.similar.length ? detail.similar : detail.recommendations;

  const openDiscover = (it: DiscoverItem) =>
    nav.navigate("DiscoverDetail", { tmdbId: it.tmdbId, mediaType: it.mediaType });

  return (
    <View style={styles.root}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* ── backdrop header ── */}
        <View style={styles.header}>
          {tmdbBackdrop(detail.backdropPath || detail.posterPath, "w1280") ? (
            <Image
              source={{ uri: tmdbBackdrop(detail.backdropPath || detail.posterPath, "w1280")! }}
              style={styles.backdrop}
              resizeMode="cover"
            />
          ) : null}
          <View pointerEvents="none" style={[styles.scrimBand, { bottom: 0, height: 160, backgroundColor: withAlpha(colors.bg.base, 0.88) }]} />
          <View pointerEvents="none" style={[styles.scrimBand, { bottom: 160, height: 120, backgroundColor: withAlpha(colors.bg.base, 0.5) }]} />
          <View pointerEvents="none" style={[styles.scrimBand, { bottom: 280, height: 120, backgroundColor: withAlpha(colors.bg.base, 0.22) }]} />
          <View pointerEvents="none" style={[styles.scrimLeft, { width: 760, backgroundColor: withAlpha(colors.bg.base, 0.3) }]} />
          <View pointerEvents="none" style={[styles.scrimLeft, { width: 480, backgroundColor: withAlpha(colors.bg.base, 0.25) }]} />

          <View style={styles.headerContent}>
            {tmdbPoster(detail.posterPath, "w342") ? (
              <Image source={{ uri: tmdbPoster(detail.posterPath, "w342")! }} style={styles.poster} resizeMode="cover" />
            ) : null}
            <View style={styles.headerInfo}>
              <Text style={styles.title} numberOfLines={2}>
                {detail.title}
              </Text>
              {!!detail.tagline && (
                <Text style={styles.tagline} numberOfLines={1}>
                  {detail.tagline}
                </Text>
              )}
              <Text style={styles.meta}>{metaBits.join("  ·  ")}</Text>
              {!!detail.genres.length && (
                <View style={styles.genreRow}>
                  {detail.genres.slice(0, 4).map((g) => (
                    <View key={g.id} style={styles.genreChip}>
                      <Text style={styles.genreText}>{g.name}</Text>
                    </View>
                  ))}
                </View>
              )}
              {!!detail.overview && (
                <Text style={styles.overview} numberOfLines={3}>
                  {detail.overview}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* ── action row ── */}
        <View style={styles.actions}>
          {mediaType === "movie" && jellyfinId ? (
            <FocusableButton
              label="Play"
              icon="▶"
              primary
              hasTVPreferredFocus
              onPress={() => nav.navigate("Player", { itemId: jellyfinId })}
            />
          ) : !available ? (
            <FocusableButton
              label={reqPending ? "Requesting…" : requested ? "Requested" : "Request"}
              icon="＋"
              primary={!requested}
              hasTVPreferredFocus
              onPress={reqPending || requested ? undefined : doRequest}
            />
          ) : (
            <FocusableButton
              label="Back"
              icon="←"
              // series-in-library hands first focus to the season picker below
              hasTVPreferredFocus={!(mediaType === "tv" && jellyfinId)}
              onPress={() => nav.goBack()}
            />
          )}
          {!!reqNote && <Text style={styles.reqNote}>{reqNote}</Text>}
        </View>

        {/* ── series in library: season picker + episodes ── */}
        {mediaType === "tv" && jellyfinId ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Episodes</Text>
            {!!seasons.length && (
              <View style={styles.seasonRow}>
                {seasons.map((s, i) => {
                  const active = s.Id === activeSeason;
                  return (
                    <FocusableButton
                      key={s.Id}
                      label={s.IndexNumber ? `Season ${s.IndexNumber}` : s.Name || `Season ${i + 1}`}
                      hasTVPreferredFocus={i === 0}
                      onPress={() => setActiveSeason(s.Id)}
                      style={active ? styles.seasonActive : undefined}
                    />
                  );
                })}
              </View>
            )}
            {epError ? (
              <Text style={styles.epError}>{epError}</Text>
            ) : !episodes.length ? (
              <Text style={styles.epError}>Loading episodes…</Text>
            ) : (
              episodes.map((ep, i) => (
                <EpisodeRow
                  key={ep.Id}
                  ep={ep}
                  index={i}
                  onPlay={() => nav.navigate("Player", { itemId: ep.Id })}
                />
              ))
            )}
          </View>
        ) : null}

        {/* ── cast ── */}
        {!!detail.cast.length && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Cast</Text>
            <FlatList
              data={detail.cast}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(c, i) => `${c.name}-${i}`}
              renderItem={({ item }) => <CastCard member={item} />}
            />
          </View>
        )}

        {/* ── more like this ── */}
        {!!moreLike.length && (
          <View style={styles.railSection}>
            <DiscoverRail title="More Like This" items={moreLike} onSelect={openDiscover} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function EpisodeRow({ ep, index, onPlay }: { ep: JfEpisode; index: number; onPlay: () => void }) {
  const [focused, setFocused] = useState(false);
  const thumb = epThumbUrl(ep);
  const mins = ep.RunTimeTicks ? Math.round(ticksToSeconds(ep.RunTimeTicks) / 60) : 0;
  return (
    <Pressable
      focusable
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPlay}
      style={[styles.epRow, focused && styles.epRowFocused]}
    >
      <Text style={styles.epIndex}>{ep.IndexNumber ?? index + 1}</Text>
      {thumb ? (
        <Image source={{ uri: thumb, headers: authHeaders() }} style={styles.epThumb} resizeMode="cover" />
      ) : (
        <View style={[styles.epThumb, styles.epThumbFallback]} />
      )}
      <View style={styles.epInfo}>
        <Text style={styles.epTitle} numberOfLines={1}>
          {ep.Name || `Episode ${ep.IndexNumber ?? index + 1}`}
        </Text>
        {!!mins && <Text style={styles.epMeta}>{mins}m</Text>}
        {!!ep.Overview && (
          <Text style={styles.epOverview} numberOfLines={2}>
            {ep.Overview}
          </Text>
        )}
      </View>
      <Text style={[styles.epPlay, focused && styles.epPlayFocused]}>▶</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.base },
  scroll: { paddingBottom: spacing.xxxl },
  header: { height: 520, width: "100%", backgroundColor: colors.bg.elevated, overflow: "hidden" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  scrimBand: { position: "absolute", left: 0, right: 0 },
  scrimLeft: { position: "absolute", top: 0, bottom: 0, left: 0 },
  headerContent: {
    position: "absolute",
    left: screenPad,
    right: screenPad,
    bottom: spacing.lg,
    flexDirection: "row",
    gap: spacing.lg,
    alignItems: "flex-end",
  },
  poster: {
    width: 180,
    height: 270,
    borderRadius: radius.md,
    backgroundColor: colors.bg.surface,
  },
  headerInfo: { flex: 1, maxWidth: 1100, paddingBottom: spacing.xs },
  title: {
    color: colors.text.primary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.black,
    textShadowColor: colors.shadow,
    textShadowRadius: 10,
  },
  tagline: {
    color: colors.text.tertiary,
    fontSize: fontSize.body,
    fontStyle: "italic",
    marginTop: 4,
  },
  meta: {
    color: colors.text.secondary,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    marginTop: spacing.sm,
  },
  genreRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" },
  genreChip: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
  },
  genreText: { color: colors.text.secondary, fontSize: fontSize.meta },
  overview: {
    color: colors.text.secondary,
    fontSize: fontSize.body,
    lineHeight: 26,
    marginTop: spacing.md,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: screenPad,
    paddingVertical: spacing.lg,
    flexWrap: "wrap",
  },
  reqNote: {
    flex: 1,
    minWidth: 300,
    color: colors.text.tertiary,
    fontSize: fontSize.caption,
    lineHeight: 20,
  },
  section: { paddingHorizontal: screenPad, marginBottom: spacing.xl },
  railSection: { marginTop: spacing.sm },
  sectionTitle: {
    color: colors.text.secondary,
    fontSize: fontSize.railTitle,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.md,
  },
  seasonRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md, flexWrap: "wrap" },
  seasonActive: {
    borderWidth: focusTokens.ringWidth,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
  },
  epError: { color: colors.text.tertiary, fontSize: fontSize.body, paddingVertical: spacing.md },
  epRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: focusTokens.ringWidth,
    borderColor: "transparent",
    backgroundColor: colors.bg.elevated,
    marginBottom: spacing.sm,
  },
  epRowFocused: { borderColor: colors.focusRing, backgroundColor: colors.bg.surface },
  epIndex: { color: colors.text.tertiary, fontSize: fontSize.h2, fontWeight: fontWeight.medium, width: 44, textAlign: "center" },
  epThumb: { width: 220, height: 124, borderRadius: radius.sm, backgroundColor: colors.bg.surface },
  epThumbFallback: { backgroundColor: colors.bg.surface },
  epInfo: { flex: 1 },
  epTitle: { color: colors.text.primary, fontSize: fontSize.body, fontWeight: fontWeight.semibold },
  epMeta: { color: colors.text.tertiary, fontSize: fontSize.meta, marginTop: 2 },
  epOverview: { color: colors.text.secondary, fontSize: fontSize.caption, marginTop: spacing.xs, lineHeight: 20 },
  epPlay: { color: colors.text.disabled, fontSize: fontSize.h2 },
  epPlayFocused: { color: colors.accent },
});
