import { useEffect, useRef, useMemo } from "react";
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

export default function MusicScreen() {
  useKeepAwake();
  const router = useRouter();
  const { state, controls } = useMediaPlayer();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();

  // Animations
  const glowAnim = useRef(new Animated.Value(0)).current;
  const artPulseAnim = useRef(new Animated.Value(1)).current;
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

  // Progress bar seek
  const progressBarWidth = useRef(0);
  const progressResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (progressBarWidth.current <= 0 || durationRef.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / progressBarWidth.current));
          seekRef.current(ratio * durationRef.current);
        },
        onPanResponderMove: (evt) => {
          const x = evt.nativeEvent.locationX;
          if (progressBarWidth.current <= 0 || durationRef.current <= 0) return;
          const ratio = Math.max(0, Math.min(1, x / progressBarWidth.current));
          seekRef.current(ratio * durationRef.current);
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

  const progressRatio = state.duration > 0 ? state.position / state.duration : 0;
  const albumArtUrl = state.albumArt ? `${HA_URL}${state.albumArt}` : null;

  const glowRadius = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 22],
  });
  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  // Layout calculations
  const contentHeight = screenHeight - TOP_BAR_HEIGHT - insets.top - insets.bottom - 24;
  const artSize = isPhone
    ? Math.min(screenWidth * 0.6, 220)
    : Math.min(contentHeight * 0.75, 250);

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
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
          gap: isPhone ? 20 : 40,
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
            maxWidth: isPhone ? screenWidth * 0.85 : 400,
            width: isPhone ? screenWidth * 0.85 : undefined,
            justifyContent: "center",
          }}
        >
          {/* Track name */}
          <Text
            numberOfLines={1}
            style={{
              color: LEGENDARY.text,
              fontSize: 20,
              fontWeight: "700",
              fontFamily: MONO,
            }}
          >
            {state.trackName || "No Track"}
          </Text>

          {/* Artist */}
          <Text
            numberOfLines={1}
            style={{
              color: "#A3A3A3",
              fontSize: 14,
              fontFamily: MONO,
              marginTop: 4,
            }}
          >
            {state.artist || "---"}
          </Text>

          {/* Album */}
          <Text
            numberOfLines={1}
            style={{
              color: "#525252",
              fontSize: 12,
              fontFamily: MONO,
              marginTop: 2,
            }}
          >
            {state.albumName || ""}
          </Text>

          {/* Progress bar */}
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
                <View
                  style={{
                    height: "100%",
                    width: `${Math.min(100, progressRatio * 100)}%`,
                    backgroundColor: LEGENDARY.border,
                    borderRadius: 3,
                  }}
                />
              </View>
              {/* Thumb */}
              <View
                style={{
                  position: "absolute",
                  left: `${Math.min(100, progressRatio * 100)}%`,
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
