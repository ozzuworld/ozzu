// ReportTab — the engagement's sanitized engineering DEBRIEF, written by DeepSeek from the run's
// trajectory (the operator FULL report stays on the bridge; the app only ever shows the membrane-
// safe debrief). Generate a mid-run snapshot while it's in progress, or a final report when it's
// done. dir_1782171502039. Auth: raw fetch — requireAuth passes app traffic over the tunnel, same
// as the wizard's create/scan POSTs.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { getBridgeUrl } from "../../lib/bridge-api";
import { colors, fontSize, fontWeight, radius, spacing } from "../../lib/design-tokens";

export function ReportTab({ engagementId }: { engagementId: string }) {
  const [debrief, setDebrief] = useState<string | null>(null);
  const [hasFull, setHasFull] = useState(false);
  const [busy, setBusy] = useState<null | "mid" | "final">(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${engagementId}/report`);
      if (r.ok) {
        const d = await r.json();
        setDebrief(d.debrief || null);
        setHasFull(!!d.has_full);
      }
    } catch {}
  }, [engagementId]);

  useEffect(() => { load(); }, [load]);

  const gen = async (kind: "mid" | "final") => {
    setBusy(kind);
    setErr(null);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${engagementId}/report?kind=${kind}`, { method: "POST" });
      const d = await r.json();
      if (r.ok) {
        setDebrief(d.debrief || null);
        setHasFull(!!d.has_full);
      } else {
        setErr(d.error || "report failed");
      }
    } catch (e: any) {
      setErr(e?.message || "report failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <GenBtn label="Mid-run debrief" busy={busy === "mid"} disabled={!!busy} onPress={() => gen("mid")} />
        <GenBtn label="Final report" busy={busy === "final"} disabled={!!busy} primary onPress={() => gen("final")} />
      </View>
      <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, lineHeight: 16 }}>
        DeepSeek writes these from the run's activity. You see the sanitized engineering debrief; the full
        operator report is saved on the bridge{hasFull ? " (generated)" : ""}.
      </Text>
      {err ? <Text style={{ color: colors.error, fontSize: fontSize.sm }}>{err}</Text> : null}
      <View style={{ backgroundColor: colors.bg.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.subtle, padding: spacing.md, minHeight: 140 }}>
        {debrief ? (
          <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm, lineHeight: 20, fontFamily: "monospace" }}>{debrief}</Text>
        ) : (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm }}>
            No report yet. Generate a mid-run debrief once the run has activity, or a final report when it completes.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function GenBtn({ label, onPress, busy, disabled, primary }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.xs,
        backgroundColor: colors.bg.elevated,
        borderRadius: radius.md,
        paddingVertical: spacing.sm + 2,
        opacity: disabled && !busy ? 0.5 : pressed ? 0.85 : 1,
        borderWidth: 1,
        borderColor: primary ? colors.accent : colors.border.subtle,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      <Text style={{ color: primary ? colors.accent : colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
        {busy ? "Writing…" : label}
      </Text>
    </Pressable>
  );
}
