import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  FlatList,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "../../components/StatusBadge";
import { useMediaPlayer } from "../../lib/useMediaPlayer";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { HA_URL, HA_TOKEN } from "../../lib/config";
import { layout } from "../../lib/design-tokens";
import { formatTrackTime, formatTrackDuration } from "../../lib/format";

import { colors } from "../../lib/design-tokens";
const BRIDGE_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";

const ACCENT = colors.brand.spotify;
const BAR_COLOR = "#FFFFFF";
const BAR_BG = "rgba(255,255,255,0.1)";
const MINI_PLAYER_HEIGHT = 56;

type MusicView = "library" | "playlist" | "nowPlaying";

interface Playlist {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  trackCount: number;
  owner: string;
}

interface Track {
  id: string;
  name: string;
  artist: string;
  albumName: string;
  albumArt: string | null;
  durationMs: number;
  explicit: boolean;
  uri: string;
}

interface QueueItem {
  name: string;
  artist: string;
  imageUrl: string | null;
}

interface NowPlayingContext {
  trackId: string | null;
  trackUri?: string;
  isPlaying: boolean;
  contextType: string | null;
  contextUri: string | null;
  contextName: string | null;
}


// ─── Mini Player ───────────────────────────────────────────────
function MiniPlayer({
  playerState,
  controls,
  onPress,
  insets,
}: {
  playerState: ReturnType<typeof useMediaPlayer>["state"];
  controls: ReturnType<typeof useMediaPlayer>["controls"];
  onPress: () => void;
  insets: { bottom: number; left: number; right: number };
}) {
  const hasTrack = !!playerState.trackName;
  if (!hasTrack && playerState.state === "idle") return null;
  if (playerState.state === "unavailable" || playerState.state === "off") return null;

  const progressRatio = playerState.duration > 0 ? playerState.position / playerState.duration : 0;
  const albumArtUrl = playerState.albumArt ? `${HA_URL}${playerState.albumArt}` : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: MINI_PLAYER_HEIGHT + insets.bottom,
        paddingBottom: insets.bottom,
        backgroundColor: "#282828",
        opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* Progress line */}
      <View style={{ height: 2, backgroundColor: "rgba(255,255,255,0.1)" }}>
        <View
          style={{
            height: "100%",
            width: `${progressRatio * 100}%`,
            backgroundColor: ACCENT,
          }}
        />
      </View>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: Math.max(12, insets.left, insets.right),
          gap: 12,
        }}
      >
        {/* Album art */}
        {albumArtUrl ? (
          <Image
            source={{
              uri: albumArtUrl,
              headers: { Authorization: `Bearer ${HA_TOKEN}` },
            }}
            style={{ width: 40, height: 40, borderRadius: 4, backgroundColor: "#383838" }}
            resizeMode="cover"
          />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 4,
              backgroundColor: "#383838",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="musical-note" size={18} color="#535353" />
          </View>
        )}
        {/* Track info */}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
            {playerState.trackName || "Not Playing"}
          </Text>
          <Text numberOfLines={1} style={{ color: "#B3B3B3", fontSize: 12 }}>
            {playerState.artist || "---"}
          </Text>
        </View>
        {/* Play/Pause */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            controls.playPause();
          }}
          style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
        >
          <Ionicons
            name={playerState.isPlaying ? "pause" : "play"}
            size={24}
            color="#FFFFFF"
          />
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── Library View ──────────────────────────────────────────────
function LibraryView({
  playlists,
  loading,
  error,
  onRetry,
  onSelectPlaylist,
  insets,
  isPhone,
}: {
  playlists: Playlist[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectPlaylist: (p: Playlist) => void;
  insets: { top: number; bottom: number; left: number; right: number };
  isPhone: boolean;
}) {
  const hPad = Math.max(16, insets.left, insets.right);

  const renderPlaylist = useCallback(
    ({ item }: { item: Playlist }) => (
      <Pressable
        onPress={() => onSelectPlaylist(item)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: hPad,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {item.id === "liked" ? (
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 4,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#7B4FE0",
            }}
          >
            <Ionicons name="heart" size={24} color="#FFFFFF" />
          </View>
        ) : item.imageUrl ? (
          <Image
            source={{ uri: item.imageUrl }}
            style={{ width: 56, height: 56, borderRadius: 4, backgroundColor: "#282828" }}
            resizeMode="cover"
          />
        ) : (
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 4,
              backgroundColor: "#282828",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="musical-notes" size={24} color="#535353" />
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "600" }}
          >
            {item.name}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: "#B3B3B3", fontSize: 13, marginTop: 2 }}
          >
            Playlist · {item.trackCount} songs
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#535353" />
      </Pressable>
    ),
    [onSelectPlaylist, hPad]
  );

  if (loading && playlists.length === 0) {
    return (
      <View style={{ flex: 1, paddingTop: 80 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 12,
              paddingHorizontal: hPad,
            }}
          >
            <View style={{ width: 56, height: 56, borderRadius: 4, backgroundColor: "#282828" }} />
            <View style={{ flex: 1, marginLeft: 12, gap: 6 }}>
              <View style={{ width: "60%", height: 14, borderRadius: 3, backgroundColor: "#282828" }} />
              <View style={{ width: "40%", height: 12, borderRadius: 3, backgroundColor: "#1E1E1E" }} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
        <Ionicons name="cloud-offline" size={48} color="#535353" />
        <Text style={{ color: "#B3B3B3", fontSize: 16, marginTop: 12, textAlign: "center" }}>
          Couldn't load playlists
        </Text>
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => ({
            marginTop: 16,
            paddingHorizontal: 24,
            paddingVertical: 10,
            borderRadius: 20,
            backgroundColor: "#282828",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      data={playlists}
      keyExtractor={(item) => item.id}
      renderItem={renderPlaylist}
      contentContainerStyle={{ paddingBottom: MINI_PLAYER_HEIGHT + insets.bottom + 16 }}
      showsVerticalScrollIndicator={false}
    />
  );
}

// ─── Playlist Detail View ──────────────────────────────────────
function PlaylistDetailView({
  playlist,
  tracks,
  total,
  hasMore,
  loadingMore,
  loading,
  error,
  onRetry,
  onLoadMore,
  onPlayTrack,
  onBack,
  onShuffle,
  onPlayAll,
  currentTrackUri,
  insets,
  isPhone,
}: {
  playlist: Playlist;
  tracks: Track[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  onPlayTrack: (track: Track, index: number) => void;
  onBack: () => void;
  onShuffle: () => void;
  onPlayAll: () => void;
  currentTrackUri: string | null;
  insets: { top: number; bottom: number; left: number; right: number };
  isPhone: boolean;
}) {
  const hPad = Math.max(16, insets.left, insets.right);

  const renderTrack = useCallback(
    ({ item, index }: { item: Track; index: number }) => {
      const isCurrentTrack = currentTrackUri && item.uri === currentTrackUri;
      return (
        <Pressable
          onPress={() => onPlayTrack(item, index)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 10,
            paddingHorizontal: hPad,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {item.albumArt ? (
            <Image
              source={{ uri: item.albumArt }}
              style={{ width: 48, height: 48, borderRadius: 4, backgroundColor: "#282828" }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 4,
                backgroundColor: "#282828",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="musical-note" size={20} color="#535353" />
            </View>
          )}
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {isCurrentTrack ? (
                <Ionicons name="volume-high" size={14} color={ACCENT} style={{ marginRight: 2 }} />
              ) : null}
              <Text
                numberOfLines={1}
                style={{
                  color: isCurrentTrack ? ACCENT : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: "500",
                  flex: 1,
                }}
              >
                {item.name}
              </Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
              {item.explicit ? (
                <View
                  style={{
                    backgroundColor: "#B3B3B3",
                    borderRadius: 2,
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                  }}
                >
                  <Text style={{ color: "#000", fontSize: 9, fontWeight: "700" }}>E</Text>
                </View>
              ) : null}
              <Text numberOfLines={1} style={{ color: "#B3B3B3", fontSize: 13, flex: 1 }}>
                {item.artist}
              </Text>
            </View>
          </View>
          <Text style={{ color: "#535353", fontSize: 12 }}>
            {formatTrackDuration(item.durationMs)}
          </Text>
        </Pressable>
      );
    },
    [currentTrackUri, onPlayTrack, hPad]
  );

  const ListHeader = useMemo(
    () => (
      <View style={{ paddingHorizontal: hPad, paddingBottom: 12 }}>
        {/* Back + Title */}
        <Pressable
          onPress={onBack}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            opacity: pressed ? 0.5 : 1,
            paddingVertical: 8,
            marginLeft: -4,
          })}
        >
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
          <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600", marginLeft: 4 }}>
            Library
          </Text>
        </Pressable>

        {/* Playlist info */}
        <Text
          numberOfLines={2}
          style={{ color: "#FFFFFF", fontSize: 24, fontWeight: "700", marginTop: 8 }}
        >
          {playlist.name}
        </Text>
        <Text style={{ color: "#B3B3B3", fontSize: 14, marginTop: 4 }}>
          {total} songs
        </Text>

        {/* Action row */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 16,
            gap: 12,
          }}
        >
          <Pressable
            onPress={onShuffle}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 20,
              backgroundColor: "rgba(255,255,255,0.08)",
              opacity: pressed ? 0.6 : 1,
              gap: 6,
            })}
          >
            <Ionicons name="shuffle" size={18} color="#FFFFFF" />
            <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>Shuffle</Text>
          </Pressable>
          <Pressable
            onPress={onPlayAll}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: ACCENT,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Ionicons name="play" size={24} color="#000000" style={{ marginLeft: 2 }} />
          </Pressable>
        </View>
      </View>
    ),
    [playlist.name, total, onBack, onShuffle, onPlayAll, hPad]
  );

  if (loading && tracks.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  if (error && tracks.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {ListHeader}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#B3B3B3", fontSize: 16 }}>Couldn't load tracks</Text>
          <Pressable
            onPress={onRetry}
            style={({ pressed }) => ({
              marginTop: 12,
              paddingHorizontal: 24,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: "#282828",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      data={tracks}
      keyExtractor={(item, i) => `${item.id}-${i}`}
      renderItem={renderTrack}
      ListHeaderComponent={ListHeader}
      ListFooterComponent={
        loadingMore ? (
          <View style={{ padding: 16, alignItems: "center" }}>
            <ActivityIndicator size="small" color={ACCENT} />
          </View>
        ) : null
      }
      onEndReached={hasMore ? onLoadMore : undefined}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingBottom: MINI_PLAYER_HEIGHT + insets.bottom + 16 }}
      showsVerticalScrollIndicator={false}
    />
  );
}

// ─── Now Playing View ──────────────────────────────────────────
function NowPlayingView({
  playerState,
  controls,
  onCollapse,
  nowPlayingContext,
  selectedPlaylist,
  insets,
  isPhone,
  screenWidth,
  screenHeight,
}: {
  playerState: ReturnType<typeof useMediaPlayer>["state"];
  controls: ReturnType<typeof useMediaPlayer>["controls"];
  onCollapse: () => void;
  nowPlayingContext: NowPlayingContext | null;
  selectedPlaylist: Playlist | null;
  insets: { top: number; bottom: number; left: number; right: number };
  isPhone: boolean;
  screenWidth: number;
  screenHeight: number;
}) {
  const [dominantColor, setDominantColor] = useState<string | null>(null);
  const colorFadeAnim = useRef(new Animated.Value(0)).current;
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const artPulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const prevTrackRef = useRef(playerState.trackName);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seekRef = useRef(controls.seek);
  const durationRef = useRef(playerState.duration);
  const setVolumeRef = useRef(controls.setVolume);
  useEffect(() => { seekRef.current = controls.seek; }, [controls.seek]);
  useEffect(() => { durationRef.current = playerState.duration; }, [playerState.duration]);
  useEffect(() => { setVolumeRef.current = controls.setVolume; }, [controls.setVolume]);

  useEffect(() => {
    return () => { if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current); };
  }, []);

  // Track change pulse
  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    if (playerState.trackName && playerState.trackName !== prevTrackRef.current) {
      anim = Animated.sequence([
        Animated.timing(artPulseAnim, { toValue: 1.03, duration: 150, useNativeDriver: true }),
        Animated.timing(artPulseAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]);
      anim.start();
    }
    prevTrackRef.current = playerState.trackName;
    return () => { if (anim) anim.stop(); };
  }, [playerState.trackName]);

  // Animated progress
  const isSeeking = useRef(false);
  useEffect(() => {
    if (isSeeking.current) return;
    const targetRatio = playerState.duration > 0 ? playerState.position / playerState.duration : 0;
    const anim = Animated.timing(progressAnim, {
      toValue: targetRatio,
      duration: 1000,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [playerState.position, playerState.duration]);

  // Dominant color
  useEffect(() => {
    if (!playerState.albumArt) { setDominantColor(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/api/album-color?url=${encodeURIComponent(playerState.albumArt)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data.hex) {
          setDominantColor(data.hex);
          colorFadeAnim.setValue(0);
          Animated.timing(colorFadeAnim, { toValue: 1, duration: 800, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
        }
      } catch {}
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [playerState.albumArt]);

  // Fetch queue
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spotify/queue`);
      if (!res.ok) { setQueue([]); return; }
      const data = await res.json();
      setQueue(data.queue || []);
    } catch { setQueue([]); }
  }, []);

  useEffect(() => { fetchQueue(); }, [playerState.trackName, fetchQueue]);

  // Progress bar seek
  const progressBarWidth = useRef(0);
  const progressResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          isSeeking.current = true;
          const x = evt.nativeEvent.locationX;
          if (progressBarWidth.current <= 0 || durationRef.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / progressBarWidth.current));
          progressAnim.setValue(ratio);
          seekRef.current(ratio * durationRef.current);
        },
        onPanResponderMove: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (progressBarWidth.current <= 0 || durationRef.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / progressBarWidth.current));
          progressAnim.setValue(ratio);
          seekRef.current(ratio * durationRef.current);
        },
        onPanResponderRelease: () => { isSeeking.current = false; },
        onPanResponderTerminate: () => { isSeeking.current = false; },
      }),
    []
  );

  // Volume slider
  const volumeBarWidth = useRef(0);
  const volumeResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (volumeBarWidth.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / volumeBarWidth.current));
          if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
          volumeDebounceRef.current = setTimeout(() => { setVolumeRef.current(ratio); }, 200);
        },
        onPanResponderMove: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (volumeBarWidth.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / volumeBarWidth.current));
          if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
          volumeDebounceRef.current = setTimeout(() => { setVolumeRef.current(ratio); }, 200);
        },
      }),
    []
  );

  const albumArtUrl = playerState.albumArt ? `${HA_URL}${playerState.albumArt}` : null;
  const animatedProgressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const isLandscape = screenWidth > screenHeight;
  const contentHeight = screenHeight - layout.topBarHeight - insets.top - insets.bottom - 24;
  const artSize = isPhone
    ? Math.min(screenWidth * 0.7, 280)
    : Math.min(contentHeight * 0.85, 380);

  const bgOverlayOpacity = dominantColor
    ? colorFadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.4] })
    : 0;

  const hasTrack = !!playerState.trackName;

  // Context label
  let contextLabel: string | null = null;
  if (nowPlayingContext?.contextUri && selectedPlaylist) {
    const playlistUri = `spotify:playlist:${selectedPlaylist.id}`;
    if (nowPlayingContext.contextUri === playlistUri || selectedPlaylist.id === "liked") {
      contextLabel = `Playing from ${selectedPlaylist.name}`;
    }
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Dominant color gradient overlay */}
      {dominantColor ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "60%",
            backgroundColor: dominantColor,
            opacity: bgOverlayOpacity,
          }}
        />
      ) : null}
      {dominantColor ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "30%",
            bottom: 0,
            backgroundColor: "#121212",
            opacity: 0.85,
          }}
        />
      ) : null}

      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: layout.topBarHeight + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(16, insets.left, insets.right),
        }}
      >
        <Pressable
          onPress={onCollapse}
          style={({ pressed }) => ({
            padding: 8,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Ionicons name="chevron-down" size={24} color="#FFFFFF" />
        </Pressable>
        {contextLabel ? (
          <Text numberOfLines={1} style={{ color: "#B3B3B3", fontSize: 12, fontWeight: "600", flex: 1, textAlign: "center", marginHorizontal: 8 }}>
            {contextLabel}
          </Text>
        ) : <View style={{ flex: 1 }} />}
        <StatusBadge />
      </View>

      {/* Main content */}
      <View
        style={{
          flex: 1,
          flexDirection: isPhone ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: Math.max(24, insets.left, insets.right),
          paddingBottom: Math.max(16, insets.bottom),
          gap: isPhone ? 24 : isLandscape ? 48 : 40,
        }}
      >
        {/* Album Art */}
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          <Animated.View
            style={{
              width: artSize,
              height: artSize,
              borderRadius: 8,
              overflow: "hidden",
              transform: [{ scale: artPulseAnim }],
              ...(Platform.OS !== "web"
                ? {
                    shadowColor: "#000",
                    shadowOpacity: 0.5,
                    shadowRadius: 20,
                    shadowOffset: { width: 0, height: 8 },
                    elevation: 12,
                  }
                : {}),
            }}
          >
            {albumArtUrl ? (
              <Image
                source={{
                  uri: albumArtUrl,
                  headers: { Authorization: `Bearer ${HA_TOKEN}` },
                }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  flex: 1,
                  backgroundColor: "#282828",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="musical-notes" size={64} color="#535353" />
              </View>
            )}
          </Animated.View>
        </View>

        {/* Track info & controls */}
        <View
          style={{
            flex: isPhone ? undefined : 1,
            maxWidth: isPhone ? screenWidth * 0.85 : 450,
            width: isPhone ? screenWidth * 0.85 : undefined,
            justifyContent: "center",
          }}
        >
          {hasTrack ? (
            <>
              <Text numberOfLines={1} style={{ color: "#FFFFFF", fontSize: 22, fontWeight: "700" }}>
                {playerState.trackName}
              </Text>
              <Text numberOfLines={1} style={{ color: "#B3B3B3", fontSize: 16, fontWeight: "400", marginTop: 4 }}>
                {playerState.artist || "---"}
              </Text>
              {playerState.albumName ? (
                <Text numberOfLines={1} style={{ color: "#686868", fontSize: 14, fontWeight: "400", marginTop: 2 }}>
                  {playerState.albumName}
                </Text>
              ) : null}
            </>
          ) : (
            <Text
              style={{
                color: "#686868",
                fontSize: 18,
                fontWeight: "500",
                textAlign: isPhone ? "center" : "left",
              }}
            >
              Not Playing
            </Text>
          )}

          {/* Progress bar */}
          <View style={{ marginTop: 24 }}>
            <View
              onLayout={(e) => { progressBarWidth.current = e.nativeEvent.layout.width; }}
              {...progressResponder.panHandlers}
              style={{ height: 20, justifyContent: "center" }}
            >
              <View style={{ height: 3, borderRadius: 2, backgroundColor: BAR_BG, overflow: "hidden" }}>
                <Animated.View
                  style={{ height: "100%", width: animatedProgressWidth, backgroundColor: BAR_COLOR, borderRadius: 2 }}
                />
              </View>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
              <Text style={{ color: "#A7A7A7", fontSize: 11 }}>{formatTrackTime(playerState.position)}</Text>
              <Text style={{ color: "#A7A7A7", fontSize: 11 }}>{formatTrackTime(playerState.duration)}</Text>
            </View>
          </View>

          {/* Transport controls */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 16,
              gap: isPhone ? 20 : 28,
            }}
          >
            <Pressable
              onPress={controls.toggleShuffle}
              style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons name="shuffle" size={22} color={playerState.shuffle ? ACCENT : "#B3B3B3"} />
            </Pressable>
            <Pressable
              onPress={controls.prevTrack}
              style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons name="play-skip-back" size={24} color="#FFFFFF" />
            </Pressable>
            <Pressable
              onPress={controls.playPause}
              style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons
                name={playerState.isPlaying ? "pause-circle" : "play-circle"}
                size={64}
                color="#FFFFFF"
              />
            </Pressable>
            <Pressable
              onPress={controls.nextTrack}
              style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons name="play-skip-forward" size={24} color="#FFFFFF" />
            </Pressable>
            <Pressable
              onPress={() => {
                const modes = ["off", "all", "one"];
                const next = modes[(modes.indexOf(playerState.repeat) + 1) % modes.length];
                controls.setRepeat(next);
              }}
              style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons name="repeat" size={22} color={playerState.repeat !== "off" ? ACCENT : "#B3B3B3"} />
              {playerState.repeat === "one" ? (
                <View
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: ACCENT,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#000", fontSize: 8, fontWeight: "700" }}>1</Text>
                </View>
              ) : null}
            </Pressable>
          </View>

          {/* Volume slider */}
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 20, gap: 10 }}>
            <Ionicons
              name={playerState.volume === 0 ? "volume-mute" : playerState.volume < 0.5 ? "volume-low" : "volume-high"}
              size={18}
              color="#B3B3B3"
            />
            <View
              onLayout={(e) => { volumeBarWidth.current = e.nativeEvent.layout.width; }}
              {...volumeResponder.panHandlers}
              style={{ flex: 1, maxWidth: 200, height: 20, justifyContent: "center" }}
            >
              <View style={{ height: 3, borderRadius: 2, backgroundColor: BAR_BG, overflow: "hidden" }}>
                <View
                  style={{
                    height: "100%",
                    width: `${playerState.volume * 100}%`,
                    backgroundColor: BAR_COLOR,
                    borderRadius: 2,
                  }}
                />
              </View>
            </View>
          </View>

          {/* Queue preview */}
          {queue.length > 0 ? (
            <View style={{ marginTop: 24 }}>
              <Text style={{ color: "#B3B3B3", fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 10 }}>
                UP NEXT
              </Text>
              {queue.slice(0, 3).map((item, i) => (
                <View
                  key={`${item.name}-${i}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }}
                >
                  {item.imageUrl ? (
                    <Image
                      source={{ uri: item.imageUrl }}
                      style={{ width: 36, height: 36, borderRadius: 4, backgroundColor: "#282828" }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 4,
                        backgroundColor: "#282828",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name="musical-note" size={16} color="#535353" />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "500" }}>{item.name}</Text>
                    <Text numberOfLines={1} style={{ color: "#B3B3B3", fontSize: 11 }}>{item.artist}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// ─── Main Music Screen ─────────────────────────────────────────
export default function MusicScreen() {
  useKeepAwake();
  const router = useRouter();
  const { state: playerState, controls } = useMediaPlayer();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();

  // View navigation
  const [view, setView] = useState<MusicView>("library");
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [previousView, setPreviousView] = useState<MusicView>("library");

  // Library state
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  // Playlist detail state
  const [playlistTracks, setPlaylistTracks] = useState<Map<string, Track[]>>(new Map());
  const [playlistTotal, setPlaylistTotal] = useState(0);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksLoadingMore, setTracksLoadingMore] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [tracksHasMore, setTracksHasMore] = useState(false);

  // Now playing context
  const [nowPlayingContext, setNowPlayingContext] = useState<NowPlayingContext | null>(null);

  // Current track URI for highlighting
  const [currentTrackUri, setCurrentTrackUri] = useState<string | null>(null);

  // Fetch playlists
  const fetchPlaylists = useCallback(async () => {
    setPlaylistsLoading(true);
    setPlaylistsError(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spotify/playlists`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlaylists(data.playlists || []);
    } catch (err: any) {
      setPlaylistsError(err.message || "Failed to load playlists");
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlaylists(); }, [fetchPlaylists]);

  // Fetch tracks for selected playlist
  const fetchTracks = useCallback(async (playlistId: string, offset = 0) => {
    if (offset === 0) {
      setTracksLoading(true);
      setTracksError(null);
    } else {
      setTracksLoadingMore(true);
    }
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spotify/playlists/${playlistId}/tracks?offset=${offset}&limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlaylistTracks((prev) => {
        const updated = new Map(prev);
        const existing = offset === 0 ? [] : (updated.get(playlistId) || []);
        updated.set(playlistId, [...existing, ...data.tracks]);
        return updated;
      });
      setPlaylistTotal(data.total);
      setTracksHasMore(data.hasMore);
    } catch (err: any) {
      setTracksError(err.message || "Failed to load tracks");
    } finally {
      setTracksLoading(false);
      setTracksLoadingMore(false);
    }
  }, []);

  // Fetch now-playing context periodically
  useEffect(() => {
    if (view !== "nowPlaying") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/api/spotify/now-playing`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          setNowPlayingContext(data);
          if (data.trackUri) setCurrentTrackUri(data.trackUri);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [view]);

  // Track current URI from now-playing context
  useEffect(() => {
    if (nowPlayingContext?.trackUri) {
      setCurrentTrackUri(nowPlayingContext.trackUri);
    }
  }, [nowPlayingContext]);

  // Navigation handlers
  const navigateToPlaylist = useCallback((playlist: Playlist) => {
    setSelectedPlaylist(playlist);
    setPreviousView("library");
    setView("playlist");
    const cached = playlistTracks.get(playlist.id);
    if (!cached || cached.length === 0) {
      fetchTracks(playlist.id, 0);
    }
  }, [playlistTracks, fetchTracks]);

  const navigateToNowPlaying = useCallback(() => {
    setPreviousView(view);
    setView("nowPlaying");
  }, [view]);

  const collapseNowPlaying = useCallback(() => {
    setView(previousView);
  }, [previousView]);

  const handlePlayTrack = useCallback(async (track: Track, index: number) => {
    if (!selectedPlaylist) return;
    try {
      const params = new URLSearchParams();
      params.set("uri", track.uri);
      if (selectedPlaylist.id !== "liked") {
        params.set("context_uri", `spotify:playlist:${selectedPlaylist.id}`);
        params.set("offset", String(index));
      }
      await fetch(`${BRIDGE_URL}/api/spotify/play?${params.toString()}`);
      setCurrentTrackUri(track.uri);
      setPreviousView("playlist");
      setView("nowPlaying");
    } catch {}
  }, [selectedPlaylist]);

  const handleShuffle = useCallback(async () => {
    if (!selectedPlaylist) return;
    controls.toggleShuffle();
    const tracks = playlistTracks.get(selectedPlaylist.id);
    if (tracks && tracks.length > 0) {
      handlePlayTrack(tracks[0], 0);
    }
  }, [selectedPlaylist, playlistTracks, controls, handlePlayTrack]);

  const handlePlayAll = useCallback(async () => {
    if (!selectedPlaylist) return;
    const tracks = playlistTracks.get(selectedPlaylist.id);
    if (tracks && tracks.length > 0) {
      handlePlayTrack(tracks[0], 0);
    }
  }, [selectedPlaylist, playlistTracks, handlePlayTrack]);

  const handleLoadMore = useCallback(() => {
    if (!selectedPlaylist || tracksLoadingMore) return;
    const cached = playlistTracks.get(selectedPlaylist.id);
    if (cached) {
      fetchTracks(selectedPlaylist.id, cached.length);
    }
  }, [selectedPlaylist, playlistTracks, tracksLoadingMore, fetchTracks]);

  const currentTracks = selectedPlaylist ? (playlistTracks.get(selectedPlaylist.id) || []) : [];

  return (
    <View style={{ flex: 1, backgroundColor: view === "nowPlaying" ? "#121212" : "#000000" }}>
      {/* Library header */}
      {view === "library" ? (
        <View
          style={{
            paddingTop: insets.top,
            height: layout.topBarHeight + insets.top,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: Math.max(16, insets.left, insets.right),
          }}
        >
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              opacity: pressed ? 0.5 : 1,
              paddingVertical: 8,
              paddingRight: 12,
            })}
          >
            <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
          </Pressable>
          <Text style={{ color: "#FFFFFF", fontSize: 20, fontWeight: "700", flex: 1 }}>
            Your Library
          </Text>
          <StatusBadge />
        </View>
      ) : null}

      {/* Playlist view safe area padding */}
      {view === "playlist" ? (
        <View style={{ paddingTop: insets.top, height: insets.top }} />
      ) : null}

      {/* Views */}
      {view === "library" ? (
        <LibraryView
          playlists={playlists}
          loading={playlistsLoading}
          error={playlistsError}
          onRetry={fetchPlaylists}
          onSelectPlaylist={navigateToPlaylist}
          insets={insets}
          isPhone={isPhone}
        />
      ) : view === "playlist" && selectedPlaylist ? (
        <PlaylistDetailView
          playlist={selectedPlaylist}
          tracks={currentTracks}
          total={playlistTotal}
          hasMore={tracksHasMore}
          loadingMore={tracksLoadingMore}
          loading={tracksLoading}
          error={tracksError}
          onRetry={() => selectedPlaylist && fetchTracks(selectedPlaylist.id, 0)}
          onLoadMore={handleLoadMore}
          onPlayTrack={handlePlayTrack}
          onBack={() => setView("library")}
          onShuffle={handleShuffle}
          onPlayAll={handlePlayAll}
          currentTrackUri={currentTrackUri}
          insets={insets}
          isPhone={isPhone}
        />
      ) : view === "nowPlaying" ? (
        <NowPlayingView
          playerState={playerState}
          controls={controls}
          onCollapse={collapseNowPlaying}
          nowPlayingContext={nowPlayingContext}
          selectedPlaylist={selectedPlaylist}
          insets={insets}
          isPhone={isPhone}
          screenWidth={screenWidth}
          screenHeight={screenHeight}
        />
      ) : null}

      {/* Mini player — visible on library and playlist views when music is playing */}
      {view !== "nowPlaying" ? (
        <MiniPlayer
          playerState={playerState}
          controls={controls}
          onPress={navigateToNowPlaying}
          insets={insets}
        />
      ) : null}

      <StatusBar style="light" />
    </View>
  );
}
