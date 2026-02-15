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

const ACCENT = "#1DB954"; // Spotify green for active states
const BAR_COLOR = "#FFFFFF";
const BAR_BG = "rgba(255,255,255,0.1)";
const TOP_BAR_HEIGHT = 48;

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface QueueItem {
  name: string;
  artist: string;
  imageUrl: string | null;
}

export default function MusicScreen() {
  useKeepAwake();
  const router = useRouter();
  const { state, controls } = useMediaPlayer();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();

  // Dominant color state
  const [dominantColor, setDominantColor] = useState<string | null>(null);
  const colorFadeAnim = useRef(new Animated.Value(0)).current;

  // Queue state
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Animations
  const artPulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const prevTrackRef = useRef(state.trackName);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shadow refs to avoid PanResponder stale closures
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

  // Track change pulse
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

  // Animated progress bar — smooth interpolation
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

  // Dominant color extraction
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
        // Silently fail — keep current background
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state.albumArt]);

  // Fetch queue on track change
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
        onPanResponderRelease: () => {
          isSeeking.current = false;
        },
        onPanResponderTerminate: () => {
          isSeeking.current = false;
        },
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

  const albumArtUrl = state.albumArt ? `${HA_URL}${state.albumArt}` : null;

  // Animated progress interpolations
  const animatedProgressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  // Layout calculations — landscape-aware
  const isLandscape = screenWidth > screenHeight;
  const contentHeight = screenHeight - TOP_BAR_HEIGHT - insets.top - insets.bottom - 24;
  const artSize = isPhone
    ? Math.min(screenWidth * 0.7, 280)
    : Math.min(contentHeight * 0.85, 380);

  // Background color with dominant color overlay
  const bgOverlayOpacity = dominantColor
    ? colorFadeAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.4],
      })
    : 0;

  const hasTrack = !!state.trackName;

  return (
    <View style={{ flex: 1, backgroundColor: "#121212" }}>
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
      {/* Gradient fade — darken the bottom */}
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
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 14,
              fontWeight: "600",
            }}
          >
            Back
          </Text>
        </Pressable>
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
        {/* Left panel — Album Art */}
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

        {/* Right panel — Track info & controls */}
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
              {/* Track name */}
              <Text
                numberOfLines={1}
                style={{
                  color: "#FFFFFF",
                  fontSize: 22,
                  fontWeight: "700",
                }}
              >
                {state.trackName}
              </Text>

              {/* Artist */}
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

              {/* Album */}
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
              style={{
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
            {/* Time labels */}
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
            {/* Shuffle */}
            <Pressable
              onPress={controls.toggleShuffle}
              style={({ pressed }) => ({
                padding: 8,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Ionicons
                name="shuffle"
                size={22}
                color={state.shuffle ? ACCENT : "#B3B3B3"}
              />
            </Pressable>

            {/* Previous */}
            <Pressable
              onPress={controls.prevTrack}
              style={({ pressed }) => ({
                padding: 8,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Ionicons name="play-skip-back" size={24} color="#FFFFFF" />
            </Pressable>

            {/* Play/Pause */}
            <Pressable
              onPress={controls.playPause}
              style={({ pressed }) => ({
                padding: 4,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Ionicons
                name={state.isPlaying ? "pause-circle" : "play-circle"}
                size={56}
                color="#FFFFFF"
              />
            </Pressable>

            {/* Next */}
            <Pressable
              onPress={controls.nextTrack}
              style={({ pressed }) => ({
                padding: 8,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Ionicons name="play-skip-forward" size={24} color="#FFFFFF" />
            </Pressable>

            {/* Repeat */}
            <Pressable
              onPress={() => {
                const modes = ["off", "all", "one"];
                const next = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
                controls.setRepeat(next);
              }}
              style={({ pressed }) => ({
                padding: 8,
                opacity: pressed ? 0.5 : 1,
              })}
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
              name={state.volume === 0 ? "volume-mute" : state.volume < 0.5 ? "volume-low" : "volume-high"}
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

          {/* Queue preview — UP NEXT */}
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

      <StatusBar style="light" />
    </View>
  );
}
