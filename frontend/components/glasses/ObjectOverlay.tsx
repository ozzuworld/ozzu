// ObjectOverlay — renders detected object bounding boxes with class labels
// Supports locked target (green) and candidate (yellow) visual states

import React from "react";
import { View, Text } from "react-native";
import Svg, { Rect, Line } from "react-native-svg";
import type { ObjectDetection } from "../../modules/expo-mediapipe";

interface ObjectOverlayProps {
  objects: ObjectDetection[];
  width: number;
  height: number;
  lockedLabel?: string; // COCO label of the locked target (solid green)
  lockedDeviceName?: string; // display name for locked device
  candidateLabel?: string; // COCO label of the candidate (pulsing yellow)
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

const LOCKED_COLOR = "#00FF88"; // green
const CANDIDATE_COLOR = "#FFAA00"; // yellow/orange

function colorForClass(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
}

export default function ObjectOverlay({
  objects,
  width,
  height,
  lockedLabel,
  lockedDeviceName,
  candidateLabel,
}: ObjectOverlayProps) {
  if (width === 0 || height === 0 || objects.length === 0) return null;

  return (
    <View style={{ position: "absolute", top: 0, left: 0, width, height }}>
      <Svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0 }}>
        {objects.map((obj, idx) => {
          const isLocked = lockedLabel && obj.label.toLowerCase() === lockedLabel.toLowerCase();
          const isCandidate = !isLocked && candidateLabel && obj.label.toLowerCase() === candidateLabel.toLowerCase();
          const color = isLocked ? LOCKED_COLOR : isCandidate ? CANDIDATE_COLOR : colorForClass(obj.label);
          const strokeW = isLocked ? 3 : isCandidate ? 2.5 : 2;
          const x = obj.x * width;
          const y = obj.y * height;
          const w = obj.width * width;
          const h = obj.height * height;
          const corner = Math.min(w, h) * 0.15;

          return (
            <React.Fragment key={idx}>
              {/* Locked: full rectangle border */}
              {isLocked ? (
                <Rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  stroke={LOCKED_COLOR}
                  strokeWidth={strokeW}
                  fill="rgba(0,255,136,0.08)"
                  rx={4}
                />
              ) : isCandidate ? (
                /* Candidate: dashed full rectangle */
                <Rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  stroke={CANDIDATE_COLOR}
                  strokeWidth={strokeW}
                  strokeDasharray="6,4"
                  fill="rgba(255,170,0,0.06)"
                  rx={4}
                />
              ) : (
                /* Default: corner brackets */
                <>
                  {/* Top-left */}
                  <Line x1={x} y1={y} x2={x + corner} y2={y} stroke={color} strokeWidth={strokeW} />
                  <Line x1={x} y1={y} x2={x} y2={y + corner} stroke={color} strokeWidth={strokeW} />
                  {/* Top-right */}
                  <Line x1={x + w - corner} y1={y} x2={x + w} y2={y} stroke={color} strokeWidth={strokeW} />
                  <Line x1={x + w} y1={y} x2={x + w} y2={y + corner} stroke={color} strokeWidth={strokeW} />
                  {/* Bottom-left */}
                  <Line x1={x} y1={y + h - corner} x2={x} y2={y + h} stroke={color} strokeWidth={strokeW} />
                  <Line x1={x} y1={y + h} x2={x + corner} y2={y + h} stroke={color} strokeWidth={strokeW} />
                  {/* Bottom-right */}
                  <Line x1={x + w - corner} y1={y + h} x2={x + w} y2={y + h} stroke={color} strokeWidth={strokeW} />
                  <Line x1={x + w} y1={y + h - corner} x2={x + w} y2={y + h} stroke={color} strokeWidth={strokeW} />
                </>
              )}
            </React.Fragment>
          );
        })}
      </Svg>

      {/* Labels */}
      {objects.map((obj, idx) => {
        const isLocked = lockedLabel && obj.label.toLowerCase() === lockedLabel.toLowerCase();
        const isCandidate = !isLocked && candidateLabel && obj.label.toLowerCase() === candidateLabel.toLowerCase();
        const color = isLocked ? LOCKED_COLOR : isCandidate ? CANDIDATE_COLOR : colorForClass(obj.label);
        const x = obj.x * width;
        const y = obj.y * height;
        const displayLabel = isLocked && lockedDeviceName
          ? lockedDeviceName.toUpperCase()
          : `${obj.label.toUpperCase()} ${Math.round(obj.score * 100)}%`;
        return (
          <View
            key={`label-${idx}`}
            style={{
              position: "absolute",
              left: x,
              top: Math.max(0, y - 18),
              backgroundColor: isLocked ? "rgba(0,255,136,0.9)" : "rgba(0,0,0,0.8)",
              paddingHorizontal: isLocked ? 6 : 4,
              paddingVertical: 1,
              borderRadius: 2,
              borderWidth: 1,
              borderColor: color,
            }}
          >
            <Text
              style={{
                color: isLocked ? "#000" : color,
                fontSize: 9,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 0.5,
              }}
            >
              {displayLabel}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
