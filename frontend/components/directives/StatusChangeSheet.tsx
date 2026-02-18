import { View, Text, Pressable, Modal } from "react-native";
import { updateDirective, type Directive } from "../../lib/bridge-api";

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  planning: "🧠",
  planned: "📋",
  approved: "✅",
  in_progress: "🔨",
  completed: "🎉",
  failed: "❌",
  cancelled: "🚫",
  stale: "💤",
  blocked: "🛑",
  deploy_failed: "🚨",
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["planning", "in_progress", "cancelled"],
  planning: ["planned", "in_progress", "cancelled"],
  planned: ["in_progress", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed", "failed", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  failed: ["pending", "cancelled"],
  stale: ["pending", "cancelled"],
  deploy_failed: ["pending", "in_progress", "cancelled"],
  cancelled: ["pending"],
};

const TRANSITION_LABELS: Record<string, string> = {
  pending: "⏳ Reopen (Pending)",
  planning: "🧠 Start Planning",
  planned: "📋 Mark Planned",
  in_progress: "🔨 Start Work",
  completed: "🎉 Mark Completed",
  failed: "❌ Mark Failed",
  cancelled: "🚫 Cancel",
  blocked: "🛑 Mark Blocked",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#737373",
  planning: "#A855F7",
  planned: "#8B5CF6",
  approved: "#FBBF24",
  in_progress: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  cancelled: "#F97316",
  stale: "#6B7280",
  blocked: "#F59E0B",
  deploy_failed: "#DC2626",
};

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
