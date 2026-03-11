import { View, Text, Pressable, Modal, ScrollView, Alert, Platform } from "react-native";
import { useState, useCallback, useEffect } from "react";
import { MarkdownContent } from "../ContentPanel";
import { resolveApproval, cancelDirective, type Directive, type EnrichedApproval } from "../../lib/bridge-api";
import { canUseBiometric, authenticateWithBiometric, BRIDGE_PIN } from "../../lib/biometric-auth";
import { TYPE_EMOJI, PRIORITY_EMOJI } from "../../lib/directive-constants";

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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);

  useEffect(() => {
    canUseBiometric().then(setHasBiometric);
  }, []);

  const doApprove = useCallback(async (pin: string) => {
    if (!approval) { setError("No approval found"); return; }
    setLoading(true);
    setError("");
    try {
      const result = await resolveApproval(approval.id, true, pin);
      if (result.ok) {
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
  }, [approval, onResolved, onDismiss]);

  const handleApprove = useCallback(async () => {
    if (hasBiometric) {
      const authenticated = await authenticateWithBiometric("Approve directive");
      if (authenticated) {
        await doApprove(BRIDGE_PIN);
      } else {
        setError("Authentication cancelled");
      }
    } else {
      // Fallback: auto-approve with bridge PIN (non-biometric devices)
      await doApprove(BRIDGE_PIN);
    }
  }, [hasBiometric, doApprove]);

  const handleDeny = useCallback(async () => {
    if (!directive) return;
    Alert.alert("Deny Plan", "Cancel this directive?", [
      { text: "No", style: "cancel" },
      {
        text: "Yes, Deny",
        style: "destructive",
        onPress: async () => {
          try {
            await cancelDirective(directive.id);
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

  const typeEmoji = TYPE_EMOJI[directive.type] || "";
  const planText = directive.plan || directive.description || "No plan details available.";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.85)",
          justifyContent: "flex-end",
          padding: 0,
        }}
        onPress={onDismiss}
      >
        <Pressable
          style={{
            backgroundColor: "#111111",
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: "85%",
            overflow: "hidden",
          }}
          onPress={() => {}}
        >
          {/* Drag handle */}
          <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ width: 36, height: 4, backgroundColor: "#333", borderRadius: 2 }} />
          </View>

          {/* Header */}
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
            <Text style={{ color: "#E5E5E5", fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
              {directive.emoji || typeEmoji} {directive.title}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <View style={{
                paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12,
                backgroundColor: directive.type === "feature" ? "#3B82F620" : "#22C55E20",
              }}>
                <Text style={{
                  color: directive.type === "feature" ? "#60A5FA" : "#4ADE80",
                  fontSize: 11, fontWeight: "600",
                }}>
                  {directive.type === "feature" ? "Feature" : "Quick Fix"}
                </Text>
              </View>
              {directive.createdBy ? (
                <Text style={{ color: "#737373", fontSize: 11 }}>by {directive.createdBy}</Text>
              ) : null}
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: "#222" }} />

          {/* Plan content */}
          <ScrollView
            style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 14 }}
            showsVerticalScrollIndicator
          >
            <MarkdownContent content={planText} />
            <View style={{ height: 20 }} />
          </ScrollView>

          {/* Actions */}
          <View style={{
            borderTopWidth: 1,
            borderTopColor: "#222",
            padding: 16,
            paddingBottom: Platform.OS === "ios" ? 34 : 16,
            backgroundColor: "#0D0D0D",
          }}>
            {error ? (
              <Text style={{ color: "#EF4444", fontSize: 12, marginBottom: 10, textAlign: "center" }}>
                {error}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 12 }}>
              <Pressable
                onPress={handleApprove}
                disabled={loading}
                style={{
                  flex: 2,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: loading ? "#1A3A1A" : "#22C55E",
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: 8,
                }}
              >
                <Text style={{ fontSize: 20 }}>{hasBiometric ? (Platform.OS === "ios" ? "" : "") : ""}</Text>
                <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>
                  {loading ? "Approving..." : hasBiometric ? "Approve" : "Approve"}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleDeny}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: "#1A1A1A",
                  borderWidth: 1,
                  borderColor: "#333",
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#EF4444", fontSize: 15, fontWeight: "600" }}>
                  Deny
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
