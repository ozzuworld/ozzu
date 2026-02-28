// ExerciseHUD — displays rep counter, angle, form quality, and exercise type

import React from "react";
import { View, Text } from "react-native";
import type { ExerciseState } from "../../lib/exercise-tracker";

interface ExerciseHUDProps {
  state: ExerciseState;
}

const QUALITY_COLORS = {
  good: "#10B981",
  warning: "#F59E0B",
  bad: "#EF4444",
};

export default function ExerciseHUD({ state }: ExerciseHUDProps) {
  if (state.exercise === "unknown") return null;

  const color = QUALITY_COLORS[state.formQuality];

  return (
    <View
      style={{
        position: "absolute",
        left: 8,
        top: 30,
        gap: 4,
      }}
    >
      {/* Exercise type */}
      <View
        style={{
          backgroundColor: "rgba(0,0,0,0.8)",
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: "#06B6D4",
        }}
      >
        <Text style={{ color: "#06B6D4", fontSize: 9, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
          {state.exercise.toUpperCase()}
        </Text>
      </View>

      {/* Rep counter */}
      <View
        style={{
          backgroundColor: "rgba(0,0,0,0.8)",
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: color,
        }}
      >
        <Text style={{ color: "#FFF", fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>
          {state.reps}
        </Text>
        <Text style={{ color: "#737373", fontSize: 8, fontFamily: "monospace", letterSpacing: 1 }}>
          REPS
        </Text>
      </View>

      {/* Angle */}
      <View
        style={{
          backgroundColor: "rgba(0,0,0,0.8)",
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 4,
        }}
      >
        <Text style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace" }}>
          {state.angle}°
        </Text>
      </View>

      {/* Form feedback */}
      {state.feedback && (
        <View
          style={{
            backgroundColor: "rgba(0,0,0,0.8)",
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: color,
          }}
        >
          <Text style={{ color, fontSize: 9, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
            {state.feedback}
          </Text>
        </View>
      )}
    </View>
  );
}
