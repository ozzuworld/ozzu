// PoseOverlay — renders body skeleton from MediaPipe PoseLandmarker (33 joints)

import React from "react";
import { View, Text } from "react-native";
import Svg, { Line, Circle } from "react-native-svg";
import type { PoseResult } from "../../modules/expo-mediapipe";

interface PoseOverlayProps {
  poses: PoseResult[];
  width: number;
  height: number;
  formQuality?: "good" | "warning" | "bad" | null;
}

// MediaPipe Pose landmark connections (skeleton bones)
const POSE_CONNECTIONS = [
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15],
  // Right arm
  [12, 14], [14, 16],
  // Left leg
  [23, 25], [25, 27], [27, 29], [27, 31],
  // Right leg
  [24, 26], [26, 28], [28, 30], [28, 32],
  // Face
  [0, 1], [1, 2], [2, 3], [3, 7], // left eye
  [0, 4], [4, 5], [5, 6], [6, 8], // right eye
  [9, 10], // mouth
];

// Joint names for exercise tracking
const JOINT_NAMES: Record<number, string> = {
  0: "nose", 11: "L shoulder", 12: "R shoulder",
  13: "L elbow", 14: "R elbow", 15: "L wrist", 16: "R wrist",
  23: "L hip", 24: "R hip", 25: "L knee", 26: "R knee",
  27: "L ankle", 28: "R ankle",
};

const FORM_COLORS = {
  good: "#10B981",
  warning: "#F59E0B",
  bad: "#EF4444",
};

const SKELETON_COLOR = "#06B6D4";
const JOINT_COLOR = "#06B6D4";
const MIN_VISIBILITY = 0.5;

export default function PoseOverlay({ poses, width, height, formQuality }: PoseOverlayProps) {
  if (width === 0 || height === 0 || poses.length === 0) return null;

  const color = formQuality ? FORM_COLORS[formQuality] : SKELETON_COLOR;

  return (
    <Svg width={width} height={height} style={{ position: "absolute", top: 0, left: 0 }}>
      {poses.map((pose, poseIdx) => {
        const lm = pose.landmarks;
        if (!lm || lm.length < 33) return null;

        return (
          <React.Fragment key={poseIdx}>
            {/* Skeleton bones */}
            {POSE_CONNECTIONS.map(([a, b], i) => {
              if (lm[a].visibility < MIN_VISIBILITY || lm[b].visibility < MIN_VISIBILITY) return null;
              return (
                <Line
                  key={`bone-${i}`}
                  x1={lm[a].x * width}
                  y1={lm[a].y * height}
                  x2={lm[b].x * width}
                  y2={lm[b].y * height}
                  stroke={color}
                  strokeWidth={2}
                  opacity={0.7}
                />
              );
            })}

            {/* Joints */}
            {lm.map((joint, idx) => {
              if (joint.visibility < MIN_VISIBILITY) return null;
              const isKeyJoint = idx in JOINT_NAMES;
              return (
                <Circle
                  key={`joint-${idx}`}
                  cx={joint.x * width}
                  cy={joint.y * height}
                  r={isKeyJoint ? 5 : 3}
                  fill={isKeyJoint ? color : JOINT_COLOR}
                  opacity={isKeyJoint ? 1 : 0.6}
                />
              );
            })}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}
