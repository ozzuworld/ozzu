import { View, Text, Pressable, Modal, Alert } from "react-native";
import { useState, useCallback, useEffect } from "react";
import { resolveApproval, type ApprovalRequest } from "../../lib/bridge-api";
import { authenticateWithBiometric, BRIDGE_PIN } from "../../lib/biometric-auth";

interface MessageApprovalModalProps {
  visible: boolean;
  approval: ApprovalRequest | null;
  onDismiss: () => void;
  onResolved: () => void;
}

const TOOL_LABELS: Record<string, string> = {
  send_whatsapp: "WhatsApp",
  send_email: "Email",
};

export function MessageApprovalModal({
  visible,
  approval,
  onDismiss,
  onResolved,
}: MessageApprovalModalProps) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const doResolve = useCallback(async (approved: boolean) => {
    if (!approval) return;
    setLoading(true);
    setError("");
    try {
      const result = await resolveApproval(approval.id, approved, BRIDGE_PIN);
      if (result.ok) {
        onResolved();
        onDismiss();
      } else {
        setError(result.error || "Failed");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [approval, onResolved, onDismiss]);

  const handleApprove = useCallback(async () => {
    const label = approval?.tool ? TOOL_LABELS[approval.tool] || approval.tool : "message";
    const ok = await authenticateWithBiometric(`Approve ${label} send`);
    if (ok) await doResolve(true);
    else setError("Authentication failed — FaceID required");
  }, [doResolve, approval]);

  const handleDeny = useCallback(() => {
    Alert.alert("Deny Send", "Block this message?", [
      { text: "Cancel", style: "cancel" },
      { text: "Block", style: "destructive", onPress: () => doResolve(false) },
    ]);
  }, [doResolve]);

  if (!approval) return null;

  const toolLabel = TOOL_LABELS[approval.tool] || approval.tool;

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" }}>
        <View style={{ backgroundColor: "#1a1a2e", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 48 }}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 16, textAlign: "center" }}>
            🔐 {toolLabel} Approval
          </Text>

          <View style={{ backgroundColor: "#16213e", borderRadius: 12, padding: 16, marginBottom: 20 }}>
            <Text style={{ color: "#a0a0b0", fontSize: 13, marginBottom: 4 }}>Cipher wants to send:</Text>
            <Text style={{ color: "#e0e0e0", fontSize: 16, lineHeight: 22 }}>{approval.description}</Text>
          </View>

          {error ? (
            <Text style={{ color: "#ff6b6b", textAlign: "center", marginBottom: 12 }}>{error}</Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 12 }}>
            <Pressable
              onPress={handleDeny}
              disabled={loading}
              style={{ flex: 1, backgroundColor: "#2d1b1b", borderRadius: 12, padding: 16, alignItems: "center" }}
            >
              <Text style={{ color: "#ff6b6b", fontSize: 16, fontWeight: "600" }}>Block</Text>
            </Pressable>

            <Pressable
              onPress={handleApprove}
              disabled={loading}
              style={{ flex: 2, backgroundColor: "#1b4332", borderRadius: 12, padding: 16, alignItems: "center" }}
            >
              <Text style={{ color: "#52b788", fontSize: 16, fontWeight: "600" }}>
                {loading ? "..." : "Approve with Face ID"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
