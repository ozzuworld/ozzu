// VisionOverlay — displays vision analysis results over the glasses video feed
// Supports multiple vision modes with different display styles

import React from "react";
import { View, Text, ScrollView } from "react-native";

export type VisionMode = "describe" | "ocr" | "identify" | "translate";

export interface VisionResult {
  mode: VisionMode;
  text: string;
  timestamp: number;
}

interface VisionOverlayProps {
  result: VisionResult | null;
  mode: VisionMode;
  loading: boolean;
}

const MODE_COLORS: Record<VisionMode, string> = {
  describe: "#06B6D4", // cyan
  ocr: "#A855F7", // purple
  identify: "#10B981", // green
  translate: "#F59E0B", // amber
};

const MODE_LABELS: Record<VisionMode, string> = {
  describe: "DESCRIBE",
  ocr: "OCR",
  identify: "IDENTIFY",
  translate: "TRANSLATE",
};

export default function VisionOverlay({ result, mode, loading }: VisionOverlayProps) {
  const color = MODE_COLORS[mode];

  if (loading) {
    return (
      <View
        style={{
          position: "absolute",
          bottom: 8,
          left: 8,
          right: 8,
          backgroundColor: "rgba(0,0,0,0.75)",
          borderRadius: 8,
          padding: 8,
          borderWidth: 1,
          borderColor: color,
        }}
      >
        <Text
          style={{
            color,
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 2,
          }}
        >
          {MODE_LABELS[mode]}...
        </Text>
      </View>
    );
  }

  if (!result || !result.text) return null;

  return (
    <View
      style={{
        position: "absolute",
        bottom: 8,
        left: 8,
        right: 8,
        maxHeight: 120,
        backgroundColor: "rgba(0,0,0,0.8)",
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <Text
        style={{
          color,
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 2,
          marginBottom: 4,
        }}
      >
        {MODE_LABELS[result.mode]}
      </Text>
      <ScrollView style={{ maxHeight: 90 }} nestedScrollEnabled>
        <Text
          style={{
            color: "#E5E5E5",
            fontSize: mode === "ocr" ? 12 : 11,
            fontFamily: "monospace",
            lineHeight: mode === "ocr" ? 16 : 15,
          }}
        >
          {result.text}
        </Text>
      </ScrollView>
    </View>
  );
}
