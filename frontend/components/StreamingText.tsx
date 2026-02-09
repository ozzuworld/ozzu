import { useEffect, useRef } from "react";
import { Animated, ScrollView, Text, View } from "react-native";

interface StreamingTextProps {
  text: string;
  streaming: boolean;
}

export function StreamingText({ text, streaming }: StreamingTextProps) {
  const cursorOpacity = useRef(new Animated.Value(1)).current;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (streaming) {
      const blink = Animated.loop(
        Animated.sequence([
          Animated.timing(cursorOpacity, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(cursorOpacity, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      );
      blink.start();
      return () => blink.stop();
    } else {
      cursorOpacity.setValue(0);
    }
  }, [streaming, cursorOpacity]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [text]);

  if (!text && !streaming) return null;

  return (
    <ScrollView
      ref={scrollRef}
      style={{ maxHeight: 200, marginTop: 16 }}
      contentContainerStyle={{ paddingHorizontal: 24 }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Text
          style={{
            color: "#E0E0E0",
            fontSize: 16,
            fontFamily: "monospace",
            lineHeight: 24,
          }}
        >
          {text}
        </Text>
        {streaming && (
          <Animated.Text
            style={{
              color: "#06B6D4",
              fontSize: 16,
              fontFamily: "monospace",
              lineHeight: 24,
              opacity: cursorOpacity,
            }}
          >
            {"▊"}
          </Animated.Text>
        )}
      </View>
    </ScrollView>
  );
}
