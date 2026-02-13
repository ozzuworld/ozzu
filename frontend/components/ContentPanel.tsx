import { useEffect, useRef } from "react";
import {
  View,
  Text,
  Animated,
  Dimensions,
  ScrollView,
  Platform,
} from "react-native";
import { TVPressable } from "./TVPressable";
import { RARITY_COLORS } from "../lib/rooms";

interface ContentPanelProps {
  visible: boolean;
  title: string;
  content: string;
  onClose: () => void;
}

const RARE = RARITY_COLORS.rare;
const SHIMMER_PERIOD = 2500;

export function ContentPanel({
  visible,
  title,
  content,
  onClose,
}: ContentPanelProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
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
        Animated.timing(slideAnim, {
          toValue: 40,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  // Shimmer glow
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

  const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
  const panelWidth = Math.min(screenWidth * 0.6, 600);
  const panelHeight = screenHeight * 0.6;

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: 20,
        left: 20,
        width: panelWidth,
        height: panelHeight,
        opacity: fadeAnim,
        transform: [{ translateY: slideAnim }],
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
          borderWidth: 1.5,
          borderColor: RARE.border,
          ...(Platform.OS === "web"
            ? {}
            : {
                elevation: 8,
                shadowColor: RARE.glow,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: glowOpacity as any,
                shadowRadius: 12,
              }),
        }}
      />

      {/* Panel container */}
      <View
        style={{
          flex: 1,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: "rgba(10, 10, 20, 0.92)",
        }}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 8,
            paddingHorizontal: 14,
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            borderBottomWidth: 1,
            borderBottomColor: "rgba(59, 130, 246, 0.2)",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: RARE.border,
                marginRight: 8,
              }}
            />
            <Text
              style={{
                color: RARE.text,
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "600",
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
              numberOfLines={1}
            >
              {title || "CIPHER OUTPUT"}
            </Text>
          </View>

          <TVPressable
            rarity="rare"
            onPress={onClose}
            style={{ paddingHorizontal: 10, paddingVertical: 4 }}
          >
            <Text
              style={{
                color: RARE.text,
                fontSize: 10,
                fontFamily: "monospace",
                fontWeight: "600",
                letterSpacing: 1,
              }}
            >
              CLOSE
            </Text>
          </TVPressable>
        </View>

        {/* Content */}
        <ScrollView
          style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 10 }}
          showsVerticalScrollIndicator={true}
        >
          <Text
            style={{
              color: "#E2E8F0",
              fontSize: 13,
              fontFamily: "monospace",
              lineHeight: 20,
            }}
            selectable
          >
            {content}
          </Text>
          {/* Bottom padding for scroll */}
          <View style={{ height: 16 }} />
        </ScrollView>
      </View>
    </Animated.View>
  );
}
