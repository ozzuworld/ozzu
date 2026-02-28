import React from "react";
import Svg, { Circle, Line } from "react-native-svg";
import type { HandResult } from "../../modules/expo-mediapipe";

// Bone connections: pairs of landmark indices to draw lines between
const BONES: [number, number][] = [
  // Thumb
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  // Index
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  // Middle
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  // Ring
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  // Pinky
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  // Palm (across MCPs)
  [5, 9],
  [9, 13],
  [13, 17],
];

// Fingertip landmark indices (rendered larger)
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

interface HandOverlayProps {
  hands: HandResult[];
  width: number;
  height: number;
  activeFingers?: number[]; // highlight these landmarks
}

export default function HandOverlay({
  hands,
  width,
  height,
  activeFingers = [],
}: HandOverlayProps) {
  if (!hands.length || !width || !height) return null;

  const activeSet = new Set(activeFingers);

  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      {hands.map((hand, handIdx) => {
        const lm = hand.landmarks;
        if (!lm || lm.length < 21) return null;

        return (
          <React.Fragment key={handIdx}>
            {/* Bones */}
            {BONES.map(([a, b], boneIdx) => (
              <Line
                key={`b-${handIdx}-${boneIdx}`}
                x1={lm[a].x * width}
                y1={lm[a].y * height}
                x2={lm[b].x * width}
                y2={lm[b].y * height}
                stroke="#00FF88"
                strokeWidth={2}
                opacity={0.7}
              />
            ))}

            {/* Landmarks */}
            {lm.map((point, idx) => {
              const isTip = FINGERTIPS.has(idx);
              const isActive = activeSet.has(idx);
              return (
                <Circle
                  key={`p-${handIdx}-${idx}`}
                  cx={point.x * width}
                  cy={point.y * height}
                  r={isActive ? 7 : isTip ? 6 : 4}
                  fill={isActive ? "#FF4444" : "#00FF88"}
                  opacity={isActive ? 1 : 0.9}
                />
              );
            })}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}
