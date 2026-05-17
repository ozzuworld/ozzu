import { useEffect, useRef } from "react";
import { Animated, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "../lib/design-tokens";
interface TranscriptBubbleProps {
  inputTranscript: string;
  responseText: string;
  isStreaming: boolean;
}

export function TranscriptBubble({
  inputTranscript,
  responseText,
  isStreaming,
}: TranscriptBubbleProps) {
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasContent = !!(inputTranscript || responseText);
  const displayText = responseText || inputTranscript;
  const isInput = !responseText && !!inputTranscript;

  // Fade in when content appears, fade out after inactivity
  useEffect(() => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }

    if (hasContent) {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();

      // Auto-fade after 8s of no streaming
      if (!isStreaming) {
        fadeTimer.current = setTimeout(() => {
          Animated.timing(opacity, {
            toValue: 0,
            duration: 1500,
            useNativeDriver: true,
          }).start();
        }, 8000);
      }
    } else {
      opacity.setValue(0);
    }

    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [hasContent, isStreaming, displayText]);

  // Auto-scroll on new text
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [displayText]);

  if (!hasContent && !isStreaming) return null;

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: Math.max(32, insets.bottom + 8),
        left: Math.max(20, insets.left + 8),
        maxWidth: "60%",
        maxHeight: 80,
        backgroundColor: "rgba(20,20,20,0.8)",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
        paddingHorizontal: 12,
        paddingVertical: 8,
        opacity,
      }}
    >
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: 64 }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Text
            style={{
              color: isInput ? "#666" : "#888",
              fontSize: 11,
              fontFamily: "monospace",
              lineHeight: 16,
              fontStyle: isInput ? "italic" : "normal",
            }}
          >
            {displayText}
          </Text>
          {isStreaming && responseText && (
            <Text
              style={{
                color: colors.accent,
                fontSize: 11,
                fontFamily: "monospace",
                lineHeight: 16,
              }}
            >
              {"▊"}
            </Text>
          )}
        </View>
      </ScrollView>
    </Animated.View>
  );
}
