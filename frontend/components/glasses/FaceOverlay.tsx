// FaceOverlay — renders face bounding boxes + expression labels over video feed

import React from "react";
import { View, Text } from "react-native";
import type { FaceResult } from "../../modules/expo-mediapipe";
import type { ExpressionResult } from "../../lib/expressions";

interface FaceOverlayProps {
  faces: FaceResult[];
  expressions: ExpressionResult[];
  width: number;
  height: number;
}

const FACE_COLORS = ["#FF6B9D", "#A855F7", "#06B6D4"]; // pink, purple, cyan for up to 3 faces

export default function FaceOverlay({ faces, expressions, width, height }: FaceOverlayProps) {
  if (width === 0 || height === 0) return null;

  return (
    <>
      {faces.map((face, i) => {
        const color = FACE_COLORS[i % FACE_COLORS.length];
        const expr = expressions[i];
        const box = face.boundingBox;

        // Convert normalized coords to pixel coords
        const left = box.x * width;
        const top = box.y * height;
        const w = box.width * width;
        const h = box.height * height;

        return (
          <View key={i}>
            {/* Bounding box */}
            <View
              style={{
                position: "absolute",
                left,
                top,
                width: w,
                height: h,
                borderWidth: 1.5,
                borderColor: color,
                borderRadius: 4,
              }}
            />
            {/* Corner brackets */}
            <View style={{ position: "absolute", left: left - 1, top: top - 1, width: 8, height: 8, borderTopWidth: 2, borderLeftWidth: 2, borderColor: color }} />
            <View style={{ position: "absolute", left: left + w - 7, top: top - 1, width: 8, height: 8, borderTopWidth: 2, borderRightWidth: 2, borderColor: color }} />
            <View style={{ position: "absolute", left: left - 1, top: top + h - 7, width: 8, height: 8, borderBottomWidth: 2, borderLeftWidth: 2, borderColor: color }} />
            <View style={{ position: "absolute", left: left + w - 7, top: top + h - 7, width: 8, height: 8, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color }} />

            {/* Expression label */}
            {expr && expr.expression !== "neutral" && (
              <View
                style={{
                  position: "absolute",
                  left,
                  top: top + h + 2,
                  backgroundColor: "rgba(0,0,0,0.75)",
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
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
                  }}
                >
                  {expr.emoji} {expr.expression.toUpperCase().replace(/_/g, " ")}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </>
  );
}
