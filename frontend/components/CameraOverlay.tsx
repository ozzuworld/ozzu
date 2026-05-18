import { useEffect, useRef, useCallback } from "react";
import { View, Text, Animated, useWindowDimensions, Platform } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { TVPressable } from "./TVPressable";
import { RARITY_COLORS } from "../lib/rooms";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "../lib/design-tokens";
interface CameraOverlayProps {
  visible: boolean;
  streamUrl: string;
  cameraName: string;
  onClose: () => void;
}

const EPIC = RARITY_COLORS.epic;
const SHIMMER_PERIOD = 2000;

export function CameraOverlay({
  visible,
  streamUrl,
  cameraName,
  onClose,
}: CameraOverlayProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  // Must be called unconditionally (Rules of Hooks)
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const player = useVideoPlayer(visible ? streamUrl : null, (p) => {
    p.loop = true;
    p.muted = false;
    p.volume = 1;
    p.play();
  });

  // Fade in/out
  useEffect(() => {
    let anim: Animated.CompositeAnimation;
    if (visible) {
      anim = Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]);
    } else {
      anim = Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.8,
          duration: 200,
          useNativeDriver: true,
        }),
      ]);
    }
    anim.start();
    return () => anim.stop();
  }, [visible]);

  // Shimmer glow animation
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: SHIMMER_PERIOD / 2,
          useNativeDriver: false,
        }),
        Animated.timing(glowAnim, {
          toValue: 0,
          duration: SHIMMER_PERIOD / 2,
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible]);

  if (!visible) return null;

  const size = Math.round(screenHeight * 0.4);

  const glowRadius = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 20],
  });

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: Math.max(20, insets.bottom + 8),
        right: Math.max(20, insets.right + 8),
        width: size,
        height: size,
        opacity: fadeAnim,
        transform: [{ scale: scaleAnim }],
        zIndex: 100,
      }}
    >
      {/* Glow border */}
      <Animated.View
        style={{
          position: "absolute",
          top: -2,
          left: -2,
          right: -2,
          bottom: -2,
          borderRadius: 14,
          borderWidth: 2,
          borderColor: EPIC.border,
          ...(Platform.OS === "web"
            ? {}
            : {
                elevation: 10,
                shadowColor: EPIC.glow,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: glowOpacity as any,
                shadowRadius: glowRadius as any,
              }),
        }}
      />

      {/* Video container */}
      <View
        style={{
          flex: 1,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: "#000",
        }}
      >
        {/* Camera name label */}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            paddingVertical: 6,
            paddingHorizontal: 10,
            backgroundColor: "rgba(0,0,0,0.6)",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.error,
                marginRight: 8,
              }}
            />
            <Text
              style={{
                color: EPIC.text,
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "600",
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              {cameraName}
            </Text>
          </View>
        </View>

        {/* HLS video player */}
        <VideoView
          player={player}
          style={{ flex: 1 }}
          nativeControls={false}
          contentFit="cover"
        />

        {/* Close button — bottom-right of overlay */}
        <View
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            zIndex: 10,
          }}
        >
          <TVPressable
            rarity="epic"
            onPress={onClose}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text
              style={{
                color: EPIC.text,
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
                letterSpacing: 1,
              }}
            >
              CLOSE
            </Text>
          </TVPressable>
        </View>
      </View>
    </Animated.View>
  );
}
