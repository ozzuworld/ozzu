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
  type ListRenderItemInfo,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "../components/StatusBadge";
import { useMediaPlayer } from "../lib/useMediaPlayer";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { HA_URL, HA_TOKEN } from "../lib/config";

const BRIDGE_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "http://10.8.0.1:3333";

const ACCENT = "#1DB954"; // Spotify green
const BAR_COLOR = "#FFFFFF";
const BAR_BG = "rgba(255,255,255,0.1)";
const TOP_BAR_HEIGHT = 48;

type MusicView = "library" | "playlist" | "nowPlaying";

interface SpotifyPlaylist {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number;
  owner: string;
  uri: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artist: string;
  albumName: string;
  albumArt: string | null;
  albumArtSmall: string | null;
  durationMs: number;
  uri: string;
}

interface QueueItem {
  name: string;
  artist: string;
  imageUrl: string | null;
}

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const MOOD_CHIPS = ["Pump Up", "Chill", "Nostalgia", "Pop", "Rap", "Hip Hop"];

export default function MusicScreen() {
  useKeepAwake();
  const router = useRouter();
  const { state, controls } = useMediaPlayer();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();

  // ── View navigation ──
  const [viewStack, setViewStack] = useState<MusicView[]>(["library"]);
  const currentView = viewStack[viewStack.length - 1];

  const pushView = useCallback((view: MusicView) => {
    setViewStack((prev) => [...prev, view]);
  }, []);

  const popView = useCallback(() => {
    if (viewStack.length <= 1) {
      router.back();
      return;
    }
    setViewStack((prev) => prev.slice(0, -1));
  }, [viewStack.length, router]);

  // ── Library state ──
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [likedTotal, setLikedTotal] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(true);

  // ── Playlist state ──
  const [selectedPlaylist, setSelectedPlaylist] = useState<{
    id: string;
    name: string;
    imageUrl: string | null;
    uri: string;
  } | null>(null);
  const [tracks, setTracks] = useState<SpotifyTrack[]>([]);
  const [tracksTotal, setTracksTotal] = useState(0);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksLoadingMore, setTracksLoadingMore] = useState(false);
  const [playingContext, setPlayingContext] = useState("");

  // ── Now Playing state (existing) ──
  const [dominantColor, setDominantColor] = useState<string | null>(null);
  const colorFadeAnim = useRef(new Animated.Value(0)).current;
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const artPulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const prevTrackRef = useRef(state.trackName);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shadow refs for PanResponder
  const seekRef = useRef(controls.seek);
  const durationRef = useRef(state.duration);
  const setVolumeRef = useRef(controls.setVolume);
  useEffect(() => { seekRef.current = controls.seek; }, [controls.seek]);
  useEffect(() => { durationRef.current = state.duration; }, [state.duration]);
  useEffect(() => { setVolumeRef.current = controls.setVolume; }, [controls.setVolume]);

  useEffect(() => {
    return () => {
      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
    };
  }, []);

  // ── Fetch library data ──
  useEffect(() => {
    let cancelled = false;
    async function fetchLibrary() {
      setLibraryLoading(true);
      try {
        const [playlistsRes, likedRes] = await Promise.all([
          fetch(`${BRIDGE_URL}/api/spotify/playlists`),
          fetch(`${BRIDGE_URL}/api/spotify/liked?offset=0`),
        ]);
        if (cancelled) return;
        if (playlistsRes.ok) {
          const data = await playlistsRes.json();
          setPlaylists(data.playlists || []);
        }
        if (likedRes.ok) {
          const data = await likedRes.json();
          setLikedTotal(data.total || 0);
        }
      } catch {
        // Silently fail
      }
      if (!cancelled) setLibraryLoading(false);
    }
    fetchLibrary();
    return () => { cancelled = true; };
  }, []);

  // ── Fetch playlist tracks ──
  const fetchTracks = useCallback(
    async (playlistId: string, offset = 0) => {
      if (offset === 0) {
        setTracksLoading(true);
        setTracks([]);
      } else {
        setTracksLoadingMore(true);
      }
      try {
        const endpoint =
          playlistId === "liked"
            ? `${BRIDGE_URL}/api/spotify/liked?offset=${offset}`
            : `${BRIDGE_URL}/api/spotify/playlists/${playlistId}/tracks?offset=${offset}`;
        const res = await fetch(endpoint);
        if (res.ok) {
          const data = await res.json();
          const newTracks: SpotifyTrack[] = data.tracks || [];
          setTracksTotal(data.total || 0);
          if (offset === 0) {
            setTracks(newTracks);
          } else {
            setTracks((prev) => [...prev, ...newTracks]);
          }
        }
      } catch {
        // Silently fail
      }
      setTracksLoading(false);
      setTracksLoadingMore(false);
    },
    []
  );

  // Load tracks when entering playlist view
  useEffect(() => {
    if (currentView === "playlist" && selectedPlaylist) {
      fetchTracks(selectedPlaylist.id);
    }
  }, [currentView, selectedPlaylist?.id, fetchTracks]);

  // ── Play a track ──
  const playTrack = useCallback(
    async (track: SpotifyTrack, contextUri?: string) => {
      try {
        const body: Record<string, unknown> = {};
        if (contextUri) {
          body.contextUri = contextUri;
          body.offset = { uri: track.uri };
        } else {
          body.uri = track.uri;
        }
        await fetch(`${BRIDGE_URL}/api/spotify/play`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setPlayingContext(selectedPlaylist?.name || "Liked Songs");
        pushView("nowPlaying");
      } catch {
        // Silently fail
      }
    },
    [selectedPlaylist, pushView]
  );

  // ── Shuffle play a playlist ──
  const shufflePlayPlaylist = useCallback(async () => {
    if (!selectedPlaylist) return;
    try {
      // Enable shuffle first
      controls.toggleShuffle();
      const contextUri =
        selectedPlaylist.id === "liked"
          ? undefined
          : selectedPlaylist.uri;
      const body: Record<string, unknown> = {};
      if (contextUri) {
        body.contextUri = contextUri;
      } else if (tracks.length > 0) {
        // For liked songs, play first track as context
        body.uri = tracks[0].uri;
      }
      await fetch(`${BRIDGE_URL}/api/spotify/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setPlayingContext(selectedPlaylist.name || "Liked Songs");
      pushView("nowPlaying");
    } catch {
      // Silently fail
    }
  }, [selectedPlaylist, tracks, controls, pushView]);

  // ── Track change pulse ──
  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    if (state.trackName && state.trackName !== prevTrackRef.current) {
      anim = Animated.sequence([
        Animated.timing(artPulseAnim, {
          toValue: 1.03,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(artPulseAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]);
      anim.start();
    }
    prevTrackRef.current = state.trackName;
    return () => { if (anim) anim.stop(); };
  }, [state.trackName]);

  // ── Animated progress bar ──
  const isSeeking = useRef(false);
  useEffect(() => {
    if (isSeeking.current) return;
    const targetRatio = state.duration > 0 ? state.position / state.duration : 0;
    const anim = Animated.timing(progressAnim, {
      toValue: targetRatio,
      duration: 1000,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [state.position, state.duration]);

  // ── Dominant color extraction ──
  useEffect(() => {
    if (!state.albumArt) {
      setDominantColor(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${BRIDGE_URL}/api/album-color?url=${encodeURIComponent(state.albumArt)}`
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data.hex) {
          setDominantColor(data.hex);
          colorFadeAnim.setValue(0);
          Animated.timing(colorFadeAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.out(Easing.ease),
            useNativeDriver: false,
          }).start();
        }
      } catch {
        // Silently fail
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state.albumArt]);

  // ── Fetch queue on track change ──
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spotify/queue`);
      if (!res.ok) { setQueue([]); return; }
      const data = await res.json();
      setQueue(data.queue || []);
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [state.trackName, fetchQueue]);

  // ── Progress bar seek PanResponder ──
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

  // ── Volume slider PanResponder ──
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
          volumeDebounceRef.current = setTimeout(() => {
            setVolumeRef.current(ratio);
          }, 200);
        },
        onPanResponderMove: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (volumeBarWidth.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / volumeBarWidth.current));
          if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
          volumeDebounceRef.current = setTimeout(() => {
            setVolumeRef.current(ratio);
          }, 200);
        },
      }),
    []
  );

  // ── Derived values ──
  const albumArtUrl = state.albumArt ? `${HA_URL}${state.albumArt}` : null;
  const animatedProgressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });
  const isLandscape = screenWidth > screenHeight;
  const contentHeight = screenHeight - TOP_BAR_HEIGHT - insets.top - insets.bottom - 24;
  const artSize = isPhone
    ? Math.min(screenWidth * 0.7, 280)
    : Math.min(contentHeight * 0.85, 380);
  const bgOverlayOpacity = dominantColor
    ? colorFadeAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.4],
      })
    : 0;
  const hasTrack = !!state.trackName;
  const hPad = Math.max(16, insets.left, insets.right);

  // ── Navigate to playlist ──
  const openPlaylist = useCallback(
    (playlist: { id: string; name: string; imageUrl: string | null; uri: string }) => {
      setSelectedPlaylist(playlist);
      pushView("playlist");
    },
    [pushView]
  );

  const openLikedSongs = useCallback(() => {
    setSelectedPlaylist({
      id: "liked",
      name: "Liked Songs",
      imageUrl: null,
      uri: "",
    });
    pushView("playlist");
  }, [pushView]);

  // ════════════════════════════════════════════════════════
  // ── Mini Now Playing Bar ──
  // ════════════════════════════════════════════════════════
  const renderMiniPlayer = () => {
    if (!hasTrack || currentView === "nowPlaying") return null;
    return (
      <Pressable
        onPress={() => pushView("nowPlaying")}
        style={{
          height: 56,
          backgroundColor: "#181818",
          borderTopWidth: 1,
          borderTopColor: "rgba(255,255,255,0.08)",
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: hPad,
          paddingBottom: Math.max(insets.bottom, 4),
        }}
      >
        {albumArtUrl ? (
          <Image
            source={{
              uri: albumArtUrl,
              headers: { Authorization: `Bearer ${HA_TOKEN}` },
            }}
            style={{
              width: 40,
              height: 40,
              borderRadius: 4,
              backgroundColor: "#282828",
            }}
            resizeMode="cover"
          />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 4,
              backgroundColor: "#282828",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="musical-note" size={18} color="#535353" />
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "600" }}
          >
            {state.trackName}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: "#B3B3B3", fontSize: 11 }}
          >
            {state.artist}
          </Text>
        </View>
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            controls.playPause();
          }}
          style={({ pressed }) => ({
            padding: 8,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Ionicons
            name={state.isPlaying ? "pause" : "play"}
            size={24}
            color="#FFFFFF"
          />
        </Pressable>
      </Pressable>
    );
  };

  // ════════════════════════════════════════════════════════
  // ── LIBRARY VIEW ──
  // ════════════════════════════════════════════════════════
  const renderLibraryView = () => {
    const renderPlaylistItem = ({ item }: ListRenderItemInfo<SpotifyPlaylist>) => (
      <Pressable
        onPress={() => openPlaylist(item)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 8,
          paddingHorizontal: hPad,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {item.imageUrl ? (
          <Image
            source={{ uri: item.imageUrl }}
            style={{
              width: 56,
              height: 56,
              borderRadius: 4,
              backgroundColor: "#282828",
            }}
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
            style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "500" }}
          >
            {item.name}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: "#B3B3B3", fontSize: 13, marginTop: 2 }}
          >
            Playlist {item.owner ? `\u00B7 ${item.owner}` : ""}
          </Text>
        </View>
      </Pressable>
    );

    const ListHeader = () => (
      <>
        {/* Filter chips */}
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: hPad,
            paddingVertical: 12,
            gap: 8,
          }}
        >
          <View
            style={{
              backgroundColor: ACCENT,
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 20,
            }}
          >
            <Text style={{ color: "#000", fontSize: 13, fontWeight: "600" }}>
              Playlists
            </Text>
          </View>
        </View>

        {/* Sort control */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: hPad,
            paddingBottom: 8,
            gap: 6,
          }}
        >
          <Ionicons name="swap-vertical" size={16} color="#FFFFFF" />
          <Text style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "500" }}>
            Recents
          </Text>
        </View>

        {/* Liked Songs card */}
        <Pressable
          onPress={openLikedSongs}
          style={({ pressed }) => ({
            marginHorizontal: hPad,
            marginBottom: 12,
            borderRadius: 8,
            overflow: "hidden",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 12,
              backgroundColor: "rgba(88, 28, 135, 0.6)",
              borderRadius: 8,
            }}
          >
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 4,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(139, 92, 246, 0.4)",
              }}
            >
              <Ionicons name="heart" size={28} color={ACCENT} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text
                style={{
                  color: "#FFFFFF",
                  fontSize: 16,
                  fontWeight: "700",
                }}
              >
                Liked Songs
              </Text>
              <Text
                style={{
                  color: "#B3B3B3",
                  fontSize: 13,
                  marginTop: 2,
                }}
              >
                Playlist {likedTotal > 0 ? `\u00B7 ${likedTotal} songs` : ""}
              </Text>
            </View>
          </View>
        </Pressable>
      </>
    );

    return (
      <View style={{ flex: 1 }}>
        {/* Top bar */}
        <View
          style={{
            paddingTop: insets.top,
            height: TOP_BAR_HEIGHT + insets.top,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: hPad,
          }}
        >
          <Pressable
            onPress={popView}
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
            <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
              Back
            </Text>
          </Pressable>
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 18,
              fontWeight: "700",
              position: "absolute",
              left: 0,
              right: 0,
              textAlign: "center",
            }}
          >
            Your Library
          </Text>
          <StatusBadge />
        </View>

        {libraryLoading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (
          <FlatList
            data={playlists}
            keyExtractor={(item) => item.id}
            renderItem={renderPlaylistItem}
            ListHeaderComponent={ListHeader}
            initialNumToRender={15}
            contentContainerStyle={{ paddingBottom: hasTrack ? 60 : 16 }}
          />
        )}

        {renderMiniPlayer()}
        <StatusBar style="light" />
      </View>
    );
  };

  // ════════════════════════════════════════════════════════
  // ── PLAYLIST VIEW ──
  // ════════════════════════════════════════════════════════
  const renderPlaylistView = () => {
    if (!selectedPlaylist) return null;
    const isLiked = selectedPlaylist.id === "liked";

    const renderTrackItem = ({ item, index }: ListRenderItemInfo<SpotifyTrack>) => (
      <Pressable
        onPress={() => {
          const contextUri = isLiked ? undefined : selectedPlaylist.uri;
          playTrack(item, contextUri);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 8,
          paddingHorizontal: hPad,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {item.albumArtSmall ? (
          <Image
            source={{ uri: item.albumArtSmall }}
            style={{
              width: 40,
              height: 40,
              borderRadius: 4,
              backgroundColor: "#282828",
            }}
            resizeMode="cover"
          />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 4,
              backgroundColor: "#282828",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="musical-note" size={18} color="#535353" />
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "500" }}
          >
            {item.name}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: "#B3B3B3", fontSize: 12, marginTop: 2 }}
          >
            {item.artist}
          </Text>
        </View>
        <Text style={{ color: "#686868", fontSize: 12, marginLeft: 8 }}>
          {formatDuration(item.durationMs)}
        </Text>
      </Pressable>
    );

    const ListHeader = () => (
      <>
        {/* Playlist header */}
        <View
          style={{
            alignItems: "center",
            paddingVertical: 20,
            paddingHorizontal: hPad,
          }}
        >
          {isLiked ? (
            <View
              style={{
                width: 140,
                height: 140,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(88, 28, 135, 0.7)",
              }}
            >
              <Ionicons name="heart" size={56} color={ACCENT} />
            </View>
          ) : selectedPlaylist.imageUrl ? (
            <Image
              source={{ uri: selectedPlaylist.imageUrl }}
              style={{
                width: 140,
                height: 140,
                borderRadius: 8,
                backgroundColor: "#282828",
              }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: 140,
                height: 140,
                borderRadius: 8,
                backgroundColor: "#282828",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="musical-notes" size={56} color="#535353" />
            </View>
          )}
          <Text
            numberOfLines={2}
            style={{
              color: "#FFFFFF",
              fontSize: 22,
              fontWeight: "700",
              marginTop: 16,
              textAlign: "center",
            }}
          >
            {selectedPlaylist.name}
          </Text>
          <Text
            style={{
              color: "#B3B3B3",
              fontSize: 13,
              marginTop: 4,
            }}
          >
            {tracksTotal} songs
          </Text>

          {/* Play button */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              marginTop: 16,
            }}
          >
            <Pressable
              onPress={shufflePlayPlaylist}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: ACCENT,
                paddingHorizontal: 32,
                paddingVertical: 12,
                borderRadius: 24,
                gap: 8,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="shuffle" size={20} color="#000" />
              <Text style={{ color: "#000", fontSize: 16, fontWeight: "700" }}>
                Shuffle Play
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Mood chips */}
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: hPad,
            paddingBottom: 12,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {MOOD_CHIPS.map((chip) => (
            <View
              key={chip}
              style={{
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.2)",
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 20,
              }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "500" }}>
                {chip}
              </Text>
            </View>
          ))}
        </View>
      </>
    );

    const loadMore = () => {
      if (tracksLoadingMore || tracks.length >= tracksTotal) return;
      fetchTracks(selectedPlaylist.id, tracks.length);
    };

    return (
      <View style={{ flex: 1 }}>
        {/* Top bar */}
        <View
          style={{
            paddingTop: insets.top,
            height: TOP_BAR_HEIGHT + insets.top,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: hPad,
          }}
        >
          <Pressable
            onPress={popView}
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
            <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
              Back
            </Text>
          </Pressable>
          <StatusBadge />
        </View>

        {tracksLoading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (
          <FlatList
            data={tracks}
            keyExtractor={(item, i) => item.id || `track-${i}`}
            renderItem={renderTrackItem}
            ListHeaderComponent={ListHeader}
            initialNumToRender={15}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            contentContainerStyle={{ paddingBottom: hasTrack ? 60 : 16 }}
            ListFooterComponent={
              tracksLoadingMore ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={ACCENT} />
                </View>
              ) : null
            }
          />
        )}

        {renderMiniPlayer()}
        <StatusBar style="light" />
      </View>
    );
  };

  // ════════════════════════════════════════════════════════
  // ── NOW PLAYING VIEW (existing, enhanced) ──
  // ════════════════════════════════════════════════════════
  const renderNowPlayingView = () => {
    return (
      <>
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
            height: TOP_BAR_HEIGHT + insets.top,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: hPad,
          }}
        >
          <Pressable
            onPress={popView}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              opacity: pressed ? 0.5 : 1,
              paddingVertical: 8,
              paddingRight: 12,
            })}
          >
            <Ionicons name="chevron-down" size={22} color="#FFFFFF" />
          </Pressable>
          {playingContext ? (
            <Text
              numberOfLines={1}
              style={{
                color: "#FFFFFF",
                fontSize: 12,
                fontWeight: "600",
                letterSpacing: 0.5,
                position: "absolute",
                left: 48,
                right: 48,
                textAlign: "center",
                top: insets.top + 14,
              }}
            >
              {playingContext}
            </Text>
          ) : null}
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
                <Text
                  numberOfLines={1}
                  style={{ color: "#FFFFFF", fontSize: 22, fontWeight: "700" }}
                >
                  {state.trackName}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: "#B3B3B3",
                    fontSize: 16,
                    fontWeight: "400",
                    marginTop: 4,
                  }}
                >
                  {state.artist || "---"}
                </Text>
                {state.albumName ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: "#686868",
                      fontSize: 14,
                      fontWeight: "400",
                      marginTop: 2,
                    }}
                  >
                    {state.albumName}
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
                onLayout={(e) => {
                  progressBarWidth.current = e.nativeEvent.layout.width;
                }}
                {...progressResponder.panHandlers}
                style={{ height: 20, justifyContent: "center" }}
              >
                <View
                  style={{
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: BAR_BG,
                    overflow: "hidden",
                  }}
                >
                  <Animated.View
                    style={{
                      height: "100%",
                      width: animatedProgressWidth,
                      backgroundColor: BAR_COLOR,
                      borderRadius: 2,
                    }}
                  />
                </View>
              </View>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  marginTop: 4,
                }}
              >
                <Text style={{ color: "#A7A7A7", fontSize: 11 }}>
                  {formatTime(state.position)}
                </Text>
                <Text style={{ color: "#A7A7A7", fontSize: 11 }}>
                  {formatTime(state.duration)}
                </Text>
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
                <Ionicons
                  name="shuffle"
                  size={22}
                  color={state.shuffle ? ACCENT : "#B3B3B3"}
                />
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
                  name={state.isPlaying ? "pause-circle" : "play-circle"}
                  size={56}
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
                  const next = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
                  controls.setRepeat(next);
                }}
                style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
              >
                <Ionicons
                  name="repeat"
                  size={22}
                  color={state.repeat !== "off" ? ACCENT : "#B3B3B3"}
                />
                {state.repeat === "one" ? (
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
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: 20,
                gap: 10,
              }}
            >
              <Ionicons
                name={
                  state.volume === 0
                    ? "volume-mute"
                    : state.volume < 0.5
                    ? "volume-low"
                    : "volume-high"
                }
                size={18}
                color="#B3B3B3"
              />
              <View
                onLayout={(e) => {
                  volumeBarWidth.current = e.nativeEvent.layout.width;
                }}
                {...volumeResponder.panHandlers}
                style={{
                  flex: 1,
                  maxWidth: 200,
                  height: 20,
                  justifyContent: "center",
                }}
              >
                <View
                  style={{
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: BAR_BG,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      height: "100%",
                      width: `${state.volume * 100}%`,
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
                <Text
                  style={{
                    color: "#B3B3B3",
                    fontSize: 12,
                    fontWeight: "700",
                    letterSpacing: 1,
                    marginBottom: 10,
                  }}
                >
                  UP NEXT
                </Text>
                {queue.slice(0, 3).map((item, i) => (
                  <View
                    key={`${item.name}-${i}`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 8,
                    }}
                  >
                    {item.imageUrl ? (
                      <Image
                        source={{ uri: item.imageUrl }}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 4,
                          backgroundColor: "#282828",
                        }}
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
                      <Text
                        numberOfLines={1}
                        style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "500" }}
                      >
                        {item.name}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{ color: "#B3B3B3", fontSize: 11 }}
                      >
                        {item.artist}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </>
    );
  };

  // ════════════════════════════════════════════════════════
  // ── MAIN RENDER ──
  // ════════════════════════════════════════════════════════
  return (
    <View style={{ flex: 1, backgroundColor: "#121212" }}>
      {currentView === "library" && renderLibraryView()}
      {currentView === "playlist" && renderPlaylistView()}
      {currentView === "nowPlaying" && (
        <>
          {renderNowPlayingView()}
          <StatusBar style="light" />
        </>
      )}
    </View>
  );
}
