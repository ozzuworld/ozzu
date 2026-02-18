import { View, Text, Pressable, Modal } from "react-native";
import { updateDirective, type Directive } from "../../lib/bridge-api";
import {
  STATUS_EMOJI,
  STATUS_COLORS,
  VALID_TRANSITIONS,
  TRANSITION_LABELS,
} from "../../lib/directive-constants";

interface StatusChangeSheetProps {
  visible: boolean;
  directive: Directive | null;
  onDismiss: () => void;
  onStatusChanged: () => void;
}

export function StatusChangeSheet({ visible, directive, onDismiss, onStatusChanged }: StatusChangeSheetProps) {
  if (!directive) return null;

  const transitions = VALID_TRANSITIONS[directive.status] || [];
  const currentEmoji = STATUS_EMOJI[directive.status] || "•";
  const currentColor = STATUS_COLORS[directive.status] || "#737373";

  const handleChange = async (newStatus: string) => {
    try {
      await updateDirective(directive.id, { status: newStatus, actor: "King Kazuma" });
      onStatusChanged();
      onDismiss();
    } catch (err: any) {
      // Alert handled by caller
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.8)",
          justifyContent: "flex-end",
        }}
        onPress={onDismiss}
      >
        <Pressable
          style={{
            backgroundColor: "#1A1A1A",
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            borderWidth: 1,
            borderColor: "#333",
            padding: 20,
            paddingBottom: 40,
          }}
          onPress={() => {}}
        >
          <Text
            style={{
              color: "#E5E5E5",
              fontSize: 14,
              fontFamily: "monospace",
              fontWeight: "bold",
              marginBottom: 4,
            }}
          >
            📝 CHANGE STATUS
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              marginBottom: 16,
              paddingVertical: 6,
            }}
          >
            <Text style={{ fontSize: 14 }}>{currentEmoji}</Text>
            <Text
              style={{
                color: currentColor,
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 0.5,
              }}
            >
              Current: {directive.status.toUpperCase().replace(/_/g, " ")}
            </Text>
          </View>

          <View style={{ height: 1, backgroundColor: "#2A2A2A", marginBottom: 12 }} />

          {transitions.map((status) => {
            const color = STATUS_COLORS[status] || "#737373";
            const label = TRANSITION_LABELS[status] || `${STATUS_EMOJI[status] || "•"} ${status}`;
            return (
              <Pressable
                key={status}
                onPress={() => handleChange(status)}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                  borderRadius: 8,
                  marginBottom: 6,
                  backgroundColor: `${color}12`,
                  borderWidth: 1,
                  borderColor: `${color}30`,
                }}
              >
                <Text
                  style={{
                    color,
                    fontSize: 13,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}

          <Pressable
            onPress={onDismiss}
            style={{
              paddingVertical: 12,
              alignItems: "center",
              marginTop: 8,
              borderRadius: 8,
              backgroundColor: "#2A2A2A",
            }}
          >
            <Text
              style={{
                color: "#737373",
                fontSize: 13,
                fontFamily: "monospace",
                fontWeight: "bold",
              }}
            >
              DISMISS
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
