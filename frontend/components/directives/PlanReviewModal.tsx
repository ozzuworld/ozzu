import { View, Text, Pressable, Modal, ScrollView, TextInput, Alert } from "react-native";
import { useState, useCallback } from "react";
import { MarkdownContent } from "../ContentPanel";
import { resolveApproval, cancelDirective, type Directive, type EnrichedApproval } from "../../lib/bridge-api";

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

const TYPE_EMOJI: Record<string, string> = {
  feature: "✨",
  quick: "⚡",
  explore: "🔍",
};

const PRIORITY_EMOJI: Record<number, string> = {
  1: "🔴",
  2: "🟠",
  3: "🟡",
  4: "⚪",
};

interface PlanReviewModalProps {
  visible: boolean;
  directive: Directive | null;
  approval: EnrichedApproval | null;
  onDismiss: () => void;
  onResolved: () => void;
}

export function PlanReviewModal({
  visible,
  directive,
  approval,
  onDismiss,
  onResolved,
}: PlanReviewModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleApprove = useCallback(async () => {
    if (!pin) {
      setError("PIN is required");
      return;
    }
    if (!approval) {
      setError("No approval found");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await resolveApproval(approval.id, true, pin);
      if (result.ok) {
        setPin("");
        onResolved();
        onDismiss();
      } else {
        setError(result.error || "Approval failed");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [pin, approval, onResolved, onDismiss]);

  const handleDeny = useCallback(async () => {
    if (!directive) return;
    Alert.alert("❌ Deny Plan", "Cancel this directive?", [
      { text: "No", style: "cancel" },
      {
        text: "Yes, Deny",
        style: "destructive",
        onPress: async () => {
          try {
            await cancelDirective(directive.id);
            setPin("");
            onResolved();
            onDismiss();
          } catch (err: any) {
            setError(err.message);
          }
        },
      },
    ]);
  }, [directive, onResolved, onDismiss]);

  if (!directive) return null;

  const typeEmoji = TYPE_EMOJI[directive.type] || "⚡";
  const priorityEmoji = PRIORITY_EMOJI[directive.priority ?? 3] || "⚪";
  const planText = directive.plan || directive.description || "No plan details available.";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.85)",
          justifyContent: "center",
          alignItems: "center",
          padding: 16,
        }}
        onPress={onDismiss}
      >
        <Pressable
          style={{
            backgroundColor: "#111",
            borderWidth: 1,
            borderColor: "#333",
            borderRadius: 14,
            width: "100%",
            maxWidth: 560,
            maxHeight: "90%",
            overflow: "hidden",
          }}
          onPress={() => {}}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              paddingVertical: 12,
              backgroundColor: "#1A1A1A",
              borderBottomWidth: 1,
              borderBottomColor: "#2A2A2A",
            }}
          >
            <Text
              style={{
                color: "#06B6D4",
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              📄 PLAN REVIEW
            </Text>
            <Pressable onPress={onDismiss}>
              <Text
                style={{
                  color: "#737373",
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                CLOSE
              </Text>
            </Pressable>
          </View>

          {/* Directive info */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: "#2A2A2A",
            }}
          >
            <Text
              style={{
                color: "#E5E5E5",
                fontSize: 14,
                fontWeight: "600",
                fontFamily: "monospace",
                marginBottom: 4,
              }}
            >
              {directive.title}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Text style={{ fontSize: 11 }}>
                {typeEmoji} {directive.type?.toUpperCase() || "QUICK"}
              </Text>
              <Text style={{ fontSize: 11 }}>
                {priorityEmoji} P{directive.priority ?? 3}
              </Text>
              {directive.createdBy ? (
                <Text
                  style={{
                    color: "#6EE7B7",
                    fontSize: 9,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                    backgroundColor: "rgba(110,231,183,0.1)",
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  {directive.createdBy}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Plan content */}
          <ScrollView
            style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 12 }}
            showsVerticalScrollIndicator
          >
            <MarkdownContent content={planText} />
            <View style={{ height: 16 }} />
          </ScrollView>

          {/* PIN + Actions */}
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: "#2A2A2A",
              padding: 16,
              backgroundColor: "#1A1A1A",
            }}
          >
            <TextInput
              value={pin}
              onChangeText={setPin}
              secureTextEntry
              maxLength={8}
              placeholder="Enter PIN to approve"
              placeholderTextColor="#444"
              autoFocus={false}
              onSubmitEditing={handleApprove}
              style={{
                backgroundColor: "#111",
                color: "#E5E5E5",
                borderWidth: 1,
                borderColor: "#333",
                borderRadius: 8,
                padding: 10,
                fontSize: 16,
                fontFamily: "monospace",
                textAlign: "center",
                letterSpacing: 6,
                marginBottom: 10,
              }}
            />

            {error ? (
              <Text
                style={{
                  color: "#EF4444",
                  fontSize: 11,
                  fontFamily: "monospace",
                  marginBottom: 8,
                  textAlign: "center",
                }}
              >
                {error}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10, justifyContent: "center" }}>
              <Pressable
                onPress={handleApprove}
                disabled={loading}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 8,
                  backgroundColor: loading ? "#333" : "#22C55E",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: "#fff",
                    fontSize: 13,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                  }}
                >
                  {loading ? "Approving..." : "✅ APPROVE"}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleDeny}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 8,
                  backgroundColor: "rgba(239,68,68,0.15)",
                  borderWidth: 1,
                  borderColor: "rgba(239,68,68,0.3)",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: "#EF4444",
                    fontSize: 13,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                  }}
                >
                  ❌ DENY
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
