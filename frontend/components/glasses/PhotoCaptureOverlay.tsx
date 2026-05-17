// PhotoCaptureOverlay — full-screen photo preview when a photo is captured via glasses
// Shows photo with fade-in animation, timestamp, save/share/dismiss controls
// Auto-dismisses after 10s or swipe down

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  Alert,
  Dimensions,
  PanResponder,
  ActivityIndicator,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  withDelay,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uploadFile, bridgeShare, sendToIntel } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
export interface CapturedPhoto {
  data: string; // base64 JPEG
  timestamp: number;
}

interface PhotoCaptureOverlayProps {
  photo: CapturedPhoto | null;
  onDismiss: () => void;
}

const { width: SCREEN_W } = Dimensions.get("window");
const AUTO_DISMISS_MS = 10000;

export default function PhotoCaptureOverlay({
  photo,
  onDismiss,
}: PhotoCaptureOverlayProps) {
  const insets = useSafeAreaInsets();
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.9);
  const translateY = useSharedValue(0);
  const flashOpacity = useSharedValue(0);
  const [saved, setSaved] = useState(false);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelResult, setIntelResult] = useState<string | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeDone, setBridgeDone] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (photo) {
      setSaved(false);
      setIntelLoading(false);
      setIntelResult(null);
      setBridgeLoading(false);
      setBridgeDone(false);
      // Flash effect then fade in
      flashOpacity.value = withSequence(
        withTiming(1, { duration: 80 }),
        withTiming(0, { duration: 200 })
      );
      opacity.value = withDelay(
        100,
        withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) })
      );
      scale.value = withDelay(
        100,
        withTiming(1, { duration: 300, easing: Easing.out(Easing.back(1.1)) })
      );
      translateY.value = 0;

      // Auto-dismiss
      dismissTimer.current = setTimeout(() => {
        handleDismiss();
      }, AUTO_DISMISS_MS);
    } else {
      opacity.value = 0;
      scale.value = 0.9;
    }

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [photo]);

  const handleDismiss = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    opacity.value = withTiming(0, { duration: 200 }, () => {
      runOnJS(onDismiss)();
    });
    scale.value = withTiming(0.9, { duration: 200 });
  };

  const getPhotoUri = async (): Promise<string> => {
    const dir = `${FileSystem.documentDirectory}glasses-photos/`;
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const fileUri = `${dir}capture_${photo!.timestamp}.jpg`;
    await FileSystem.writeAsStringAsync(fileUri, photo!.data, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return fileUri;
  };

  const handleSave = async () => {
    if (!photo || saved) return;
    try {
      await getPhotoUri();
      // Also upload to personal file storage
      uploadFile(photo.data, {
        filename: `glasses_${photo.timestamp}.jpg`,
        source: "glasses",
        category: "photos",
      }).catch(() => {}); // fire-and-forget
      setSaved(true);
    } catch (e: any) {
      Alert.alert("Save failed", e.message || "Could not save photo");
    }
  };

  const handleShare = async () => {
    if (!photo) return;
    try {
      const fileUri = await getPhotoUri();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, { mimeType: "image/jpeg" });
      }
    } catch {}
  };

  const handleSendToIntel = async () => {
    if (!photo || intelLoading) return;
    setIntelLoading(true);
    try {
      // Also save to personal storage under intel category
      await uploadFile(photo.data, {
        filename: `glasses_${photo.timestamp}.jpg`,
        source: "glasses",
        category: "intel",
      });
      const result = await sendToIntel(photo.data, `Glasses capture ${new Date(photo.timestamp).toISOString()}`);
      setIntelResult(result.message);
    } catch (e: any) {
      setIntelResult("Failed: " + (e.message || "Unknown error"));
    } finally {
      setIntelLoading(false);
    }
  };

  const handleBridgeShare = async () => {
    if (!photo || bridgeLoading || bridgeDone) return;
    setBridgeLoading(true);
    try {
      await bridgeShare(photo.data, `glasses_${photo.timestamp}.jpg`);
      setBridgeDone(true);
    } catch (e: any) {
      Alert.alert("Share failed", e.message || "Could not share via bridge");
    } finally {
      setBridgeLoading(false);
    }
  };

  // Swipe down to dismiss via PanResponder
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 10,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) {
          translateY.value = g.dy;
          opacity.value = Math.max(0, 1 - g.dy / 300);
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120) {
          handleDismiss();
        } else {
          translateY.value = withTiming(0, { duration: 200 });
          opacity.value = withTiming(1, { duration: 200 });
        }
      },
    })
  ).current;

  const containerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { translateY: translateY.value },
    ],
  }));

  const flashStyle = useAnimatedStyle(() => ({
    opacity: flashOpacity.value,
  }));

  if (!photo) return null;

  const timeStr = new Date(photo.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateStr = new Date(photo.timestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      {/* Camera flash effect */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#fff",
            zIndex: 998,
          },
          flashStyle,
        ]}
      />

      {/* Photo overlay */}
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.92)",
            zIndex: 999,
            justifyContent: "center",
            alignItems: "center",
          },
          containerStyle,
        ]}
      >
        {/* Top bar — timestamp + close */}
        <View
          style={{
            position: "absolute",
            top: insets.top + 8,
            left: 16,
            right: 16,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            zIndex: 10,
          }}
        >
          <View>
            <Text
              style={{
                color: colors.accent,
                fontSize: 11,
                fontFamily: "monospace",
                letterSpacing: 1,
                opacity: 0.8,
              }}
            >
              META GLASSES CAPTURE
            </Text>
            <Text
              style={{
                color: "#fff",
                fontSize: 14,
                fontFamily: "monospace",
                marginTop: 2,
              }}
            >
              {timeStr} {dateStr}
            </Text>
          </View>

          <Pressable
            onPress={handleDismiss}
            hitSlop={20}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: "rgba(255,255,255,0.15)",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ color: "#fff", fontSize: 18, fontWeight: "600" }}>
              X
            </Text>
          </Pressable>
        </View>

        {/* Photo */}
        <Image
          source={{ uri: `data:image/jpeg;base64,${photo.data}` }}
          style={{
            width: SCREEN_W - 32,
            height: (SCREEN_W - 32) * 0.75,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "rgba(6,182,212,0.3)",
          }}
          resizeMode="contain"
        />

        {/* Swipe indicator */}
        <View
          style={{
            marginTop: 16,
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: "rgba(255,255,255,0.3)",
          }}
        />

        {/* Intel result banner */}
        {intelResult && (
          <View
            style={{
              marginTop: 12,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: intelResult.startsWith("Failed")
                ? "rgba(239,68,68,0.2)"
                : "rgba(168,85,247,0.2)",
              maxWidth: SCREEN_W - 48,
            }}
          >
            <Text
              style={{
                color: intelResult.startsWith("Failed") ? colors.error : colors.brand.purple,
                fontSize: 11,
                fontFamily: "monospace",
                textAlign: "center",
              }}
            >
              {intelResult}
            </Text>
          </View>
        )}

        {/* Bottom controls — 2x2 grid */}
        <View
          style={{
            position: "absolute",
            bottom: Math.max(insets.bottom + 16, 32),
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 12,
            paddingHorizontal: 24,
          }}
        >
          {/* Save */}
          <Pressable
            onPress={handleSave}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: saved
                ? "rgba(16,185,129,0.25)"
                : "rgba(255,255,255,0.12)",
              borderWidth: 1,
              borderColor: saved ? "#10B981" : "rgba(255,255,255,0.2)",
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 16 }}>{saved ? "\u2713" : "\u{1F4BE}"}</Text>
            <Text
              style={{
                color: saved ? "#10B981" : "#fff",
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
              }}
            >
              {saved ? "SAVED" : "SAVE"}
            </Text>
          </Pressable>

          {/* Share (iOS native) */}
          <Pressable
            onPress={handleShare}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: "rgba(255,255,255,0.12)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.2)",
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 16 }}>{"\u{1F4E4}"}</Text>
            <Text
              style={{
                color: "#fff",
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
              }}
            >
              SHARE
            </Text>
          </Pressable>

          {/* Intel VIP */}
          <Pressable
            onPress={handleSendToIntel}
            disabled={intelLoading}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: intelResult && !intelResult.startsWith("Failed")
                ? "rgba(168,85,247,0.25)"
                : "rgba(168,85,247,0.12)",
              borderWidth: 1,
              borderColor: colors.brand.purple,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              opacity: intelLoading ? 0.6 : 1,
            }}
          >
            {intelLoading ? (
              <ActivityIndicator size="small" color={colors.brand.purple} />
            ) : (
              <Text style={{ fontSize: 16 }}>{"\u{1F50D}"}</Text>
            )}
            <Text
              style={{
                color: colors.brand.purple,
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
              }}
            >
              INTEL
            </Text>
          </Pressable>

          {/* Bridge Share (temp 24h link) */}
          <Pressable
            onPress={handleBridgeShare}
            disabled={bridgeLoading || bridgeDone}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: bridgeDone
                ? "rgba(6,182,212,0.25)"
                : "rgba(6,182,212,0.12)",
              borderWidth: 1,
              borderColor: colors.accent,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              opacity: bridgeLoading ? 0.6 : 1,
            }}
          >
            {bridgeLoading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={{ fontSize: 16 }}>{bridgeDone ? "\u2713" : "\u{1F517}"}</Text>
            )}
            <Text
              style={{
                color: colors.accent,
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
              }}
            >
              {bridgeDone ? "SHARED" : "BRIDGE"}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </>
  );
}
