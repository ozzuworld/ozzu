import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  Easing,
  PanResponder,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { TVPressable } from "../components/TVPressable";
import { StatusBadge } from "../components/StatusBadge";
import { RARITY_COLORS } from "../lib/rooms";
import { useMediaPlayer } from "../lib/useMediaPlayer";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { HA_URL, HA_TOKEN } from "../lib/config";

const BRIDGE_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "http://10.8.0.1:3333";

const LEGENDARY = RARITY_COLORS.legendary;
const SHIMMER_PERIOD = 1500;
const TOP_BAR_HEIGHT = 48;
const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

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
  const glowAnim = useRef(new Animated.Value(0)).current;
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

  // Shimmer glow loop
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: SHIMMER_PERIOD / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
        Animated.timing(glowAnim, {
          toValue: 0,
          duration: SHIMMER_PERIOD / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // Track change pulse
  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    if (state.trackName && state.trackName !== prevTrackRef.current) {
      anim = Animated.sequence([
        Animated.timing(artPulseAnim, {
          toValue: 1.05,
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
          // Animate the color fade in
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
    }, 200); // 200ms debounce
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

  const glowRadius = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 22],
  });
  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  // Animated progress interpolations
  const animatedProgressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });
  const animatedThumbLeft = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  // Layout calculations — landscape-aware
  const isLandscape = screenWidth > screenHeight;
  const contentHeight = screenHeight - TOP_BAR_HEIGHT - insets.top - insets.bottom - 24;
  const artSize = isPhone
    ? Math.min(screenWidth * 0.6, 220)
    : Math.min(contentHeight * 0.85, 350);

  // Background color with dominant color overlay
  const bgOverlayOpacity = dominantColor
    ? colorFadeAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.35],
      })
    : 0;

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      {/* Dominant color gradient overlay */}
      {dominantColor ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: dominantColor,
            opacity: bgOverlayOpacity,
          }}
        />
      ) : null}
      {/* Gradient fade — darken the bottom half */}
      {dominantColor ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "60%",
            backgroundColor: "#000000",
            opacity: 0.7,
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
        <TVPressable
          onPress={() => router.back()}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 4,
            borderRadius: 6,
          }}
        >
          <Text
            style={{
              color: "#A3A3A3",
              fontSize: 12,
              fontWeight: "bold",
              letterSpacing: 1,
              fontFamily: MONO,
            }}
          >
            {"◀ BACK"}
          </Text>
        </TVPressable>
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
          gap: isPhone ? 20 : isLandscape ? 48 : 40,
        }}
      >
        {/* Left panel — Album Art */}
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          {/* Glow border */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: -3,
              left: -3,
              right: -3,
              bottom: -3,
              borderRadius: 14,
              borderWidth: 1.5,
              borderColor: LEGENDARY.border,
              ...(Platform.OS !== "web"
                ? {
                    shadowColor: LEGENDARY.glow,
                    shadowOpacity: glowOpacity as any,
                    shadowRadius: glowRadius as any,
                    shadowOffset: { width: 0, height: 0 },
                    elevation: 16,
                  }
                : {}),
            }}
          />

          <Animated.View
            style={{
              width: artSize,
              height: artSize,
              borderRadius: 12,
              borderWidth: 2,
              borderColor: LEGENDARY.border,
              overflow: "hidden",
              transform: [{ scale: artPulseAnim }],
              ...(Platform.OS !== "web"
                ? {
                    shadowColor: LEGENDARY.glow,
                    shadowOpacity: 0.6,
                    shadowRadius: 14,
                    shadowOffset: { width: 0, height: 0 },
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
                  backgroundColor: "rgba(245,158,11,0.1)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 48 }}>🎵</Text>
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
          {/* Track name — large, bold, white */}
          <Text
            numberOfLines={1}
            style={{
              color: "#FFFFFF",
              fontSize: 24,
              fontWeight: "800",
            }}
          >
            {state.trackName || "No Track"}
          </Text>

          {/* Artist — muted, tappable look */}
          <TVPressable
            rarity="common"
            style={{ alignSelf: "flex-start", marginTop: 4 }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: "#B3B3B3",
                fontSize: 16,
                fontWeight: "500",
              }}
            >
              {state.artist || "---"}
            </Text>
          </TVPressable>

          {/* Album — subtle */}
          <Text
            numberOfLines={1}
            style={{
              color: "#686868",
              fontSize: 13,
              fontWeight: "400",
              marginTop: 2,
            }}
          >
            {state.albumName || ""}
          </Text>

          {/* Animated Progress bar */}
          <View style={{ marginTop: 20 }}>
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
              {/* Track background */}
              <View
                style={{
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: "rgba(245,158,11,0.15)",
                  overflow: "hidden",
                }}
              >
                <Animated.View
                  style={{
                    height: "100%",
                    width: animatedProgressWidth,
                    backgroundColor: LEGENDARY.border,
                    borderRadius: 3,
                  }}
                />
              </View>
              {/* Animated Thumb */}
              <Animated.View
                style={{
                  position: "absolute",
                  left: animatedThumbLeft,
                  marginLeft: -7,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: LEGENDARY.border,
                  ...(Platform.OS !== "web"
                    ? {
                        shadowColor: LEGENDARY.glow,
                        shadowOpacity: 0.8,
                        shadowRadius: 6,
                        shadowOffset: { width: 0, height: 0 },
                        elevation: 6,
                      }
                    : {}),
                }}
              />
            </View>
            {/* Time labels */}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                marginTop: 4,
              }}
            >
              <Text style={{ color: "#525252", fontSize: 11, fontFamily: MONO }}>
                {formatTime(state.position)}
              </Text>
              <Text style={{ color: "#525252", fontSize: 11, fontFamily: MONO }}>
                {formatTime(state.duration)}
              </Text>
            </View>
          </View>

          {/* Controls row */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 16,
              gap: 12,
            }}
          >
            {/* Shuffle */}
            <TVPressable
              rarity="legendary"
              onPress={controls.toggleShuffle}
              style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: state.shuffle ? 1 : 0.4 }}
            >
              <Text style={{ color: LEGENDARY.text, fontSize: 18 }}>🔀</Text>
            </TVPressable>

            {/* Previous */}
            <TVPressable
              rarity="legendary"
              onPress={controls.prevTrack}
              style={{ paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text
                style={{
                  color: LEGENDARY.text,
                  fontSize: 22,
                  fontWeight: "700",
                  fontFamily: MONO,
                }}
              >
                ◀◀
              </Text>
            </TVPressable>

            {/* Play/Pause */}
            <TVPressable
              rarity="legendary"
              onPress={controls.playPause}
              style={{
                paddingHorizontal: 20,
                paddingVertical: 10,
              }}
            >
              <Text
                style={{
                  color: LEGENDARY.text,
                  fontSize: 36,
                  fontWeight: "700",
                }}
              >
                {state.isPlaying ? "⏸" : "▶"}
              </Text>
            </TVPressable>

            {/* Next */}
            <TVPressable
              rarity="legendary"
              onPress={controls.nextTrack}
              style={{ paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text
                style={{
                  color: LEGENDARY.text,
                  fontSize: 22,
                  fontWeight: "700",
                  fontFamily: MONO,
                }}
              >
                ▶▶
              </Text>
            </TVPressable>

            {/* Repeat */}
            <TVPressable
              rarity="legendary"
              onPress={() => {
                const modes = ["off", "all", "one"];
                const next = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
                controls.setRepeat(next);
              }}
              style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: state.repeat !== "off" ? 1 : 0.4 }}
            >
              <Text style={{ color: LEGENDARY.text, fontSize: 18 }}>
                {state.repeat === "one" ? "🔂" : "🔁"}
              </Text>
            </TVPressable>
          </View>

          {/* Volume slider */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginTop: 16,
              gap: 8,
            }}
          >
            <Text style={{ color: "#525252", fontSize: 14 }}>🔊</Text>
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
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: "rgba(245,158,11,0.15)",
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: `${state.volume * 100}%`,
                    backgroundColor: LEGENDARY.border,
                    borderRadius: 2,
                  }}
                />
              </View>
            </View>
          </View>

          {/* Queue preview — UP NEXT */}
          {queue.length > 0 ? (
            <View style={{ marginTop: 20 }}>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 10,
                  fontWeight: "700",
                  letterSpacing: 2,
                  fontFamily: MONO,
                  marginBottom: 8,
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
                    gap: 10,
                    marginBottom: 6,
                  }}
                >
                  {item.imageUrl ? (
                    <Image
                      source={{ uri: item.imageUrl }}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 4,
                        backgroundColor: "#1a1a1a",
                      }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 4,
                        backgroundColor: "#1a1a1a",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ fontSize: 14 }}>🎵</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text
                      numberOfLines={1}
                      style={{ color: "#B3B3B3", fontSize: 13, fontWeight: "500" }}
                    >
                      {item.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{ color: "#525252", fontSize: 11 }}
                    >
                      {item.artist}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {/* Source indicator */}
          {state.source ? (
            <Text
              style={{
                color: "#333",
                fontSize: 10,
                fontFamily: MONO,
                marginTop: 16,
                letterSpacing: 2,
              }}
            >
              {"[ "}SOURCE: {state.source.toUpperCase()}{" ]"}
            </Text>
          ) : null}
        </View>
      </View>

      <StatusBar style="light" />
    </View>
  );
}
