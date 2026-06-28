import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, View, Text } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing, withAlpha } from "../lib/design-tokens";
import { useAvatarStream } from "../lib/useAvatarStream";

interface Props {
  active: boolean;
  style?: object;
}

export function AvatarVideo({ active, style }: Props) {
  const { connected, gpuConnected, frameUri, fps } = useAvatarStream(active);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: frameUri ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [frameUri, fadeAnim]);

  return (
    <View style={[styles.container, style]}>
      {frameUri ? (
        <Animated.View style={[styles.imageWrap, { opacity: fadeAnim }]}>
          <Image source={{ uri: frameUri }} style={styles.image} resizeMode="cover" />
        </Animated.View>
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderEmoji}>
            {!connected ? "..." : !gpuConnected ? "..." : "..."}
          </Text>
          <Text style={styles.placeholderText}>
            {!connected
              ? "Connecting..."
              : !gpuConnected
                ? "GPU offline"
                : "Waiting for video"}
          </Text>
        </View>
      )}

      {/* Status indicator */}
      <View style={styles.statusBar}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: gpuConnected ? colors.success : colors.error },
          ]}
        />
        <Text style={styles.statusText}>
          {gpuConnected ? `LIVE ${fps > 0 ? fps + "fps" : ""}` : "OFFLINE"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.bg.base,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  imageWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  placeholderEmoji: {
    fontSize: 14,
    color: colors.text.disabled,
  },
  placeholderText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text.disabled,
  },
  statusBar: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: withAlpha(colors.bg.base, 0.7),
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.text.tertiary,
    letterSpacing: 0.5,
  },
});
