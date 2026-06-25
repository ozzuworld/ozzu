import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { getBridgeUrl } from "../../lib/bridge-api";
import { colors, fontSize, fontWeight, radius, spacing } from "../../lib/design-tokens";

type Observation = {
  id: number;
  question: string;
  context: string;
  response: string | null;
  status: "pending" | "answered";
};

export function ObservationsTab({ engagementId }: { engagementId: string }) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${engagementId}/observations`);
      if (r.ok) {
        const d = await r.json();
        setObservations(d.observations || []);
      }
    } catch {} finally { setLoading(false); }
  }, [engagementId]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const pending = observations.filter(o => o.status === "pending");
  const answered = observations.filter(o => o.status === "answered");

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingTop: spacing.xxl }}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }

  if (observations.length === 0) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }}>
        <View style={{
          backgroundColor: colors.gray[800],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border.subtle,
          padding: spacing.lg,
          alignItems: "center",
          gap: spacing.sm,
        }}>
          <Text style={{ fontSize: 28 }}>👁</Text>
          <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm, textAlign: "center", lineHeight: 20 }}>
            No observation requests yet. When the model needs physical info about the target
            (brand, label, LED state), it will appear here for you to answer.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md }}>
      {pending.length > 0 && (
        <Text style={{ color: colors.warning, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, textTransform: "uppercase", letterSpacing: 1 }}>
          Needs your input ({pending.length})
        </Text>
      )}
      {pending.map(obs => (
        <ObservationCard key={obs.id} obs={obs} engagementId={engagementId} onResponded={load} />
      ))}
      {answered.length > 0 && (
        <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, textTransform: "uppercase", letterSpacing: 1, marginTop: spacing.sm }}>
          Answered ({answered.length})
        </Text>
      )}
      {answered.map(obs => (
        <ObservationCard key={obs.id} obs={obs} engagementId={engagementId} onResponded={load} />
      ))}
    </ScrollView>
  );
}

function ObservationCard({ obs, engagementId, onResponded }: { obs: Observation; engagementId: string; onResponded: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const isPending = obs.status === "pending";

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${engagementId}/observations/${obs.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: reply.trim() }),
      });
      if (r.ok) {
        setReply("");
        onResponded();
      }
    } catch {} finally { setSending(false); }
  };

  return (
    <View style={{
      backgroundColor: colors.bg.elevated,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: isPending ? colors.warning : colors.border.subtle,
      borderLeftWidth: 3,
      borderLeftColor: isPending ? colors.warning : colors.success,
      padding: spacing.md,
      gap: spacing.sm,
    }}>
      <Text style={{ color: colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, lineHeight: 20 }}>
        {obs.question}
      </Text>
      {obs.context ? (
        <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, lineHeight: 16 }}>
          {obs.context}
        </Text>
      ) : null}

      {isPending ? (
        <View style={{ gap: spacing.xs, marginTop: spacing.xs }}>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Type your observation..."
            placeholderTextColor={colors.text.disabled}
            multiline
            style={{
              backgroundColor: colors.gray[800],
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: colors.border.subtle,
              padding: spacing.sm,
              color: colors.text.primary,
              fontSize: fontSize.sm,
              minHeight: 60,
              textAlignVertical: "top",
            }}
          />
          <Pressable
            onPress={send}
            disabled={sending || !reply.trim()}
            style={({ pressed }) => ({
              backgroundColor: colors.accent,
              borderRadius: radius.sm,
              paddingVertical: spacing.sm,
              alignItems: "center",
              opacity: sending || !reply.trim() ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.text.primary} />
            ) : (
              <Text style={{ color: colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
                Send
              </Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={{
          backgroundColor: colors.gray[800],
          borderRadius: radius.sm,
          padding: spacing.sm,
          marginTop: spacing.xs,
        }}>
          <Text style={{ color: colors.success, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginBottom: 2 }}>
            Your response:
          </Text>
          <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm, lineHeight: 18 }}>
            {obs.response}
          </Text>
        </View>
      )}
    </View>
  );
}
