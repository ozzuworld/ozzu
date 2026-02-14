import { useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  Easing,
  PanResponder,
  useWindowDimensions,
  Platform,
} from "react-native";
import { TVPressable } from "./TVPressable";
import { RARITY_COLORS } from "../lib/rooms";
import { useMediaPlayer } from "../lib/useMediaPlayer";
import { HA_URL, HA_TOKEN } from "../lib/config";

interface MediaPlayerProps {
  visible: boolean;
  onClose: () => void;
}

const LEGENDARY = RARITY_COLORS.legendary;
const SHIMMER_PERIOD = 1500;

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MediaPlayer({ visible, onClose }: MediaPlayerProps) {
  const { state, controls } = useMediaPlayer();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.3)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const artPulseAnim = useRef(new Animated.Value(1)).current;
  const prevTrackRef = useRef(state.trackName);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Open/close animation
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.3,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  // Shimmer glow loop
  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

  // Track change pulse
  useEffect(() => {
    if (state.trackName && state.trackName !== prevTrackRef.current) {
      Animated.sequence([
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
      ]).start();
    }
    prevTrackRef.current = state.trackName;
  }, [state.trackName]);

  // Progress bar seek
  const progressBarWidth = useRef(0);
  const handleProgressSeek = useCallback(
    (locationX: number) => {
      if (progressBarWidth.current <= 0 || state.duration <= 0) return;
      const ratio = Math.max(0, Math.min(1, locationX / progressBarWidth.current));
      controls.seek(ratio * state.duration);
    },
    [state.duration, controls]
  );

  const progressResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        handleProgressSeek(evt.nativeEvent.locationX);
      },
      onPanResponderMove: (evt) => {
        handleProgressSeek(evt.nativeEvent.locationX);
      },
    })
  ).current;

  // Volume slider
  const volumeBarWidth = useRef(0);
  const handleVolumeChange = useCallback(
    (locationX: number) => {
      if (volumeBarWidth.current <= 0) return;
      const ratio = Math.max(0, Math.min(1, locationX / volumeBarWidth.current));
      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
      volumeDebounceRef.current = setTimeout(() => {
        controls.setVolume(ratio);
      }, 200);
    },
    [controls]
  );

  const volumeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        handleVolumeChange(evt.nativeEvent.locationX);
      },
      onPanResponderMove: (evt) => {
        handleVolumeChange(evt.nativeEvent.locationX);
      },
    })
  ).current;

  if (!visible) return null;

  const panelWidth = Math.min(screenWidth * 0.55, 480);
  const panelHeight = Math.min(screenHeight * 0.50, 260);
  const artSize = Math.min(100, panelHeight - 60);
  const progressRatio = state.duration > 0 ? state.position / state.duration : 0;
  const albumArtUrl = state.albumArt
    ? `${HA_URL}${state.albumArt}`
    : null;

  const glowRadius = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 16],
  });
  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: 20,
        right: 20,
        width: panelWidth,
        height: panelHeight,
        zIndex: 100,
        opacity: fadeAnim,
        transform: [{ scale: scaleAnim }],
      }}
    >
      {/* Border glow */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: -2,
          left: -2,
          right: -2,
          bottom: -2,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: LEGENDARY.border,
          ...(Platform.OS !== "web"
            ? {
                shadowColor: LEGENDARY.glow,
                shadowOpacity: glowOpacity as any,
                shadowRadius: glowRadius as any,
                shadowOffset: { width: 0, height: 0 },
                elevation: 12,
              }
            : {}),
        }}
      />

      {/* Panel background */}
      <View
        style={{
          flex: 1,
          backgroundColor: "#111111",
          borderRadius: 8,
          borderWidth: 1,
          borderColor: "rgba(245,158,11,0.3)",
          overflow: "hidden",
          padding: 12,
          flexDirection: "column",
        }}
      >
        {/* Top row: album art + track info + close */}
        <View style={{ flexDirection: "row", flex: 1 }}>
          {/* Album art */}
          <Animated.View
            style={{
              width: artSize,
              height: artSize,
              borderRadius: 8,
              borderWidth: 2,
              borderColor: LEGENDARY.border,
              overflow: "hidden",
              transform: [{ scale: artPulseAnim }],
              ...(Platform.OS !== "web"
                ? {
                    shadowColor: LEGENDARY.glow,
                    shadowOpacity: 0.6,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 0 },
                    elevation: 8,
                  }
                : {}),
            }}
          >
            {albumArtUrl ? (
              <Image
                source={{ uri: albumArtUrl }}
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
                <Text style={{ fontSize: 32 }}>🎵</Text>
              </View>
            )}
          </Animated.View>

          {/* Track info */}
          <View style={{ flex: 1, marginLeft: 12, justifyContent: "center" }}>
            <Text
              numberOfLines={1}
              style={{
                color: LEGENDARY.text,
                fontSize: 14,
                fontWeight: "700",
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
              }}
            >
              {state.trackName || "No Track"}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: "#A3A3A3",
                fontSize: 11,
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                marginTop: 2,
              }}
            >
              {state.artist || "---"}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: "#525252",
                fontSize: 10,
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                marginTop: 1,
              }}
            >
              {state.albumName || ""}
            </Text>
          </View>

          {/* Close button */}
          <TVPressable
            rarity="legendary"
            onPress={onClose}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              alignSelf: "flex-start",
            }}
          >
            <Text
              style={{
                color: LEGENDARY.text,
                fontSize: 12,
                fontWeight: "700",
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
              }}
            >
              X
            </Text>
          </TVPressable>
        </View>

        {/* Progress bar */}
        <View style={{ marginTop: 8 }}>
          <View
            onLayout={(e) => {
              progressBarWidth.current = e.nativeEvent.layout.width;
            }}
            {...progressResponder.panHandlers}
            style={{
              height: 14,
              justifyContent: "center",
            }}
          >
            {/* Track background */}
            <View
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: "rgba(245,158,11,0.15)",
                overflow: "hidden",
              }}
            >
              {/* Fill */}
              <View
                style={{
                  height: "100%",
                  width: `${Math.min(100, progressRatio * 100)}%`,
                  backgroundColor: LEGENDARY.border,
                  borderRadius: 2,
                }}
              />
            </View>
            {/* Thumb */}
            <View
              style={{
                position: "absolute",
                left: `${Math.min(100, progressRatio * 100)}%`,
                marginLeft: -5,
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: LEGENDARY.border,
                ...(Platform.OS !== "web"
                  ? {
                      shadowColor: LEGENDARY.glow,
                      shadowOpacity: 0.8,
                      shadowRadius: 4,
                      shadowOffset: { width: 0, height: 0 },
                      elevation: 4,
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
              marginTop: 2,
            }}
          >
            <Text
              style={{
                color: "#525252",
                fontSize: 9,
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
              }}
            >
              {formatTime(state.position)}
            </Text>
            <Text
              style={{
                color: "#525252",
                fontSize: 9,
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
              }}
            >
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
            marginTop: 6,
            gap: 6,
          }}
        >
          {/* Shuffle */}
          <TVPressable
            rarity="legendary"
            onPress={controls.toggleShuffle}
            style={{ paddingHorizontal: 6, paddingVertical: 4, opacity: state.shuffle ? 1 : 0.4 }}
          >
            <Text style={{ color: LEGENDARY.text, fontSize: 14 }}>🔀</Text>
          </TVPressable>

          {/* Previous */}
          <TVPressable
            rarity="legendary"
            onPress={controls.prevTrack}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text
              style={{
                color: LEGENDARY.text,
                fontSize: 16,
                fontWeight: "700",
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
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
              paddingHorizontal: 14,
              paddingVertical: 6,
            }}
          >
            <Text
              style={{
                color: LEGENDARY.text,
                fontSize: 22,
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
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text
              style={{
                color: LEGENDARY.text,
                fontSize: 16,
                fontWeight: "700",
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
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
            style={{ paddingHorizontal: 6, paddingVertical: 4, opacity: state.repeat !== "off" ? 1 : 0.4 }}
          >
            <Text style={{ color: LEGENDARY.text, fontSize: 14 }}>
              {state.repeat === "one" ? "🔂" : "🔁"}
            </Text>
          </TVPressable>

          {/* Volume */}
          <View style={{ flexDirection: "row", alignItems: "center", marginLeft: 8 }}>
            <Text style={{ color: "#525252", fontSize: 10, marginRight: 4 }}>🔊</Text>
            <View
              onLayout={(e) => {
                volumeBarWidth.current = e.nativeEvent.layout.width;
              }}
              {...volumeResponder.panHandlers}
              style={{
                width: 60,
                height: 14,
                justifyContent: "center",
              }}
            >
              <View
                style={{
                  height: 3,
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
        </View>
      </View>
    </Animated.View>
  );
}
