import { View, Text, ActivityIndicator } from "react-native";
import { TVPressable } from "../TVPressable";

export type FaceMatch = {
  cedula: string;
  fullName: string | null;
  similarity: number;
};

type Props = {
  match: FaceMatch | null;
  scanning: boolean;
  onRunScan: () => void;
  onDismiss: () => void;
};

export default function FaceMatchOverlay({ match, scanning, onRunScan, onDismiss }: Props) {
  if (!match && !scanning) return null;

  return (
    <View
      style={{
        position: "absolute",
        bottom: 100,
        left: 16,
        right: 16,
        backgroundColor: "rgba(0,0,0,0.85)",
        borderRadius: 16,
        borderWidth: 1,
        borderColor: scanning ? "#F59E0B" : "#00FF88",
        padding: 16,
      }}
    >
      {scanning && !match && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ActivityIndicator size="small" color="#F59E0B" />
          <Text style={{ color: "#F59E0B", fontSize: 12, fontFamily: "monospace" }}>
            SEARCHING FACE DB...
          </Text>
        </View>
      )}

      {match && (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={{ color: "#00FF88", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
              MATCH FOUND
            </Text>
            <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace" }}>
              {Math.round(match.similarity * 100)}% CONFIDENCE
            </Text>
          </View>

          <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "monospace", fontWeight: "bold", marginBottom: 4 }}>
            {match.fullName || "Unknown"}
          </Text>
          <Text style={{ color: "#A3A3A3", fontSize: 12, fontFamily: "monospace", marginBottom: 12 }}>
            CC {match.cedula}
          </Text>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TVPressable
              onPress={onRunScan}
              style={{
                flex: 1,
                backgroundColor: "#06B6D4",
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#000", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                RUN FULL OSINT SCAN
              </Text>
            </TVPressable>
            <TVPressable
              onPress={onDismiss}
              style={{
                paddingVertical: 10,
                paddingHorizontal: 16,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#525252",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace" }}>
                DISMISS
              </Text>
            </TVPressable>
          </View>
        </>
      )}
    </View>
  );
}
