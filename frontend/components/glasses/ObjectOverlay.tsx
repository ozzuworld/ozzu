// ObjectOverlay — renders detected object bounding boxes with class labels

import React from "react";
import { View, Text } from "react-native";
import Svg, { Rect, Line } from "react-native-svg";
import type { ObjectDetection } from "../../modules/expo-mediapipe";

interface ObjectOverlayProps {
  objects: ObjectDetection[];
  width: number;
  height: number;
}

// Color palette for different object classes
const CLASS_COLORS = [
  "#06B6D4", // cyan
  "#A855F7", // purple
  "#F59E0B", // amber
  "#10B981", // emerald
  "#EF4444", // red
  "#3B82F6", // blue
  "#EC4899", // pink
  "#F97316", // orange
];

function colorForClass(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
}

export default function ObjectOverlay({ objects, width, height }: ObjectOverlayProps) {
  if (width === 0 || height === 0 || objects.length === 0) return null;

  return (
    <View style={{ position: "absolute", top: 0, left: 0, width, height }}>
      <Svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0 }}>
        {objects.map((obj, idx) => {
          const color = colorForClass(obj.label);
          const x = obj.x * width;
          const y = obj.y * height;
          const w = obj.width * width;
          const h = obj.height * height;
          const corner = Math.min(w, h) * 0.15;

          return (
            <React.Fragment key={idx}>
              {/* Corner brackets instead of full rectangle */}
              {/* Top-left */}
              <Line x1={x} y1={y} x2={x + corner} y2={y} stroke={color} strokeWidth={2} />
              <Line x1={x} y1={y} x2={x} y2={y + corner} stroke={color} strokeWidth={2} />
              {/* Top-right */}
              <Line x1={x + w - corner} y1={y} x2={x + w} y2={y} stroke={color} strokeWidth={2} />
              <Line x1={x + w} y1={y} x2={x + w} y2={y + corner} stroke={color} strokeWidth={2} />
              {/* Bottom-left */}
              <Line x1={x} y1={y + h - corner} x2={x} y2={y + h} stroke={color} strokeWidth={2} />
              <Line x1={x} y1={y + h} x2={x + corner} y2={y + h} stroke={color} strokeWidth={2} />
              {/* Bottom-right */}
              <Line x1={x + w - corner} y1={y + h} x2={x + w} y2={y + h} stroke={color} strokeWidth={2} />
              <Line x1={x + w} y1={y + h - corner} x2={x + w} y2={y + h} stroke={color} strokeWidth={2} />
            </React.Fragment>
          );
        })}
      </Svg>

      {/* Labels */}
      {objects.map((obj, idx) => {
        const color = colorForClass(obj.label);
        const x = obj.x * width;
        const y = obj.y * height;
        return (
          <View
            key={`label-${idx}`}
            style={{
              position: "absolute",
              left: x,
              top: Math.max(0, y - 18),
              backgroundColor: "rgba(0,0,0,0.8)",
              paddingHorizontal: 4,
              paddingVertical: 1,
              borderRadius: 2,
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
                letterSpacing: 0.5,
              }}
            >
              {obj.label.toUpperCase()} {Math.round(obj.score * 100)}%
            </Text>
          </View>
        );
      })}
    </View>
  );
}
