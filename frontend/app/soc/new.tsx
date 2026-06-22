// New-engagement wizard — device-aware creation with a live Wi-Fi gate.
// dir_1782136917098 (Phase 1 of the SOC redesign). Steps: Basics → Target →
// Executor (live device cards from /soc/executors) → Gate verdict → ROE/Autonomy → Review.
// Locked decision: when the chosen executor is online but NOT on the target Wi-Fi,
// the engagement opens with "gain Wi-Fi access" as Objective #1.

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { TopBar } from "../../components/TopBar";
import { getBridgeUrl } from "../../lib/bridge-api";
import {
  colors, spacing, radius, fontSize as fs, fontWeight as fw, withAlpha,
} from "../../lib/design-tokens";

type Executor = {
  device_id: string;
  status: "online" | "stale" | "offline";
  online: boolean;
  wifi_ssid: string | null;
  lan_ip: string | null;
  lan_subnet: string | null;
  wg_ip: string | null;
  wg_up: boolean;
  wg_handshake_age_s: number | null;
  battery_pct: number | null;
  executor_capable: boolean;
};

const ENGAGEMENT_TYPES = [
  { key: "internal_pentest", label: "Internal" },
  { key: "external_pentest", label: "External" },
  { key: "webapp", label: "Web app" },
  { key: "redteam", label: "Red team" },
  { key: "compliance", label: "Compliance" },
];

const AUTONOMY = [
  { key: "recon_only", label: "Recon only", hint: "Discovery + enumeration, no exploitation" },
  { key: "exploitation_auto", label: "Autonomous", hint: "Full autonomous run — recon → exploit" },
  { key: "full_engagement", label: "Full + post-exploit", hint: "Everything, including post-exploitation" },
];

const STEPS = ["Basics", "Target", "Executor", "Gate", "Autonomy", "Review"];

// Status dot color for a device.
function deviceColor(e: Executor): string {
  if (!e.online) return colors.error;
  if (!e.wg_up) return colors.warning;
  return colors.success;
}

type Verdict = { kind: "ready" | "wifi" | "offline" | "none"; title: string; detail: string; color: string };

// The live Wi-Fi gate: compare the chosen executor's network against the target.
function gateVerdict(e: Executor | null, ssid: string, subnet: string): Verdict {
  if (!e) return { kind: "none", title: "Pick an executor", detail: "Choose a device above to check reachability.", color: colors.text.tertiary };
  if (!e.online) {
    return { kind: "offline", title: `${e.device_id} is offline`, detail: "Bring it online or pick another device — the engagement can't run through a device that isn't up.", color: colors.error };
  }
  const onSsid = ssid && e.wifi_ssid && e.wifi_ssid.trim().toLowerCase() === ssid.trim().toLowerCase();
  const onSubnet = subnet && e.lan_subnet && e.lan_subnet === subnet.trim();
  if (onSsid || onSubnet) {
    return { kind: "ready", title: `${e.device_id} can reach the target`, detail: `On ${e.wifi_ssid || e.lan_subnet} — proceeds straight to the target network.`, color: colors.success };
  }
  // Online but not on the target Wi-Fi → auto first-objective (locked decision).
  return {
    kind: "wifi",
    title: "Wi-Fi access becomes Objective #1",
    detail: `${e.device_id} is on ${e.wifi_ssid ? `"${e.wifi_ssid}"` : "another network"}, not the target${ssid ? ` "${ssid}"` : ""}. The engagement will open by gaining access to the target Wi-Fi, then flow into the real targets once on-net.`,
    color: colors.warning,
  };
}

export default function SOCNewScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Form
  const [client, setClient] = useState("");
  const [type, setType] = useState("internal_pentest");
  const [targetSsid, setTargetSsid] = useState("");
  const [targetSubnet, setTargetSubnet] = useState("");
  const [autonomy, setAutonomy] = useState("exploitation_auto");

  // Executors
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [loadingExec, setLoadingExec] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const selectedExec = useMemo(() => executors.find((e) => e.device_id === selected) || null, [executors, selected]);
  const verdict = useMemo(() => gateVerdict(selectedExec, targetSsid, targetSubnet), [selectedExec, targetSsid, targetSubnet]);

  const fetchExecutors = useCallback(async () => {
    setLoadingExec(true);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/executors`);
      const d = await r.json();
      setExecutors(d.executors || []);
    } catch (e) {
      console.error("fetch executors failed", e);
    } finally {
      setLoadingExec(false);
    }
  }, []);

  useEffect(() => { fetchExecutors(); }, [fetchExecutors]);

  const canNext = useMemo(() => {
    if (step === 0) return client.trim().length > 0;
    if (step === 1) return targetSsid.trim().length > 0 || targetSubnet.trim().length > 0;
    if (step === 2) return !!selected;
    if (step === 3) return verdict.kind === "ready" || verdict.kind === "wifi"; // offline must be resolved
    return true;
  }, [step, client, targetSsid, targetSubnet, selected, verdict]);

  const create = useCallback(async () => {
    setSubmitting(true);
    try {
      const target_networks = [{ ssid: targetSsid.trim() || null, subnet: targetSubnet.trim() || null, reachable_via: selected }];
      const body: any = {
        client_name: client.trim(),
        engagement_type: type,
        scope: { targets: targetSubnet.trim() ? [targetSubnet.trim()] : [], allowed: [], prohibited: [] },
        target_networks,
        executor_host: selected,
        metadata: { permission_mode: autonomy },
      };
      if (verdict.kind === "wifi") {
        body.first_objective = "gain_wifi_access";
        body.wifi_target = targetSsid.trim();
      }
      const r = await fetch(`${getBridgeUrl()}/soc/engagements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.id) router.replace(`/soc/${d.id}`);
      else { setSubmitting(false); }
    } catch (e) {
      console.error("create failed", e);
      setSubmitting(false);
    }
  }, [client, type, targetSsid, targetSubnet, selected, autonomy, verdict, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />
      <TopBar title="🛡️ New Engagement" background={colors.bg.elevated} borderBottom />

      {/* Step rail */}
      <View style={styles.stepRail}>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, alignItems: "center", gap: 4 }}>
            <View style={[styles.stepDot, i === step && styles.stepDotActive, i < step && styles.stepDotDone]} />
            <Text style={{ color: i === step ? colors.accent : colors.text.disabled, fontSize: fs.xs, fontWeight: i === step ? fw.semibold : fw.normal }}>{s}</Text>
          </View>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxxl }}>
        {step === 0 && (
          <>
            <Field label="Client / target name">
              <TextInput value={client} onChangeText={setClient} placeholder="e.g. Edificio Laura" placeholderTextColor={colors.text.disabled} style={styles.input} />
            </Field>
            <Field label="Engagement type">
              <View style={styles.chipWrap}>
                {ENGAGEMENT_TYPES.map((t) => (
                  <Chip key={t.key} label={t.label} active={type === t.key} onPress={() => setType(t.key)} />
                ))}
              </View>
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <Field label="Target Wi-Fi (SSID)">
              <TextInput value={targetSsid} onChangeText={setTargetSsid} placeholder="e.g. EDIFICIO LAURA" placeholderTextColor={colors.text.disabled} style={styles.input} autoCapitalize="characters" />
            </Field>
            <Field label="Target subnet (optional)">
              <TextInput value={targetSubnet} onChangeText={setTargetSubnet} placeholder="e.g. 192.168.1.0/24" placeholderTextColor={colors.text.disabled} style={styles.input} autoCapitalize="none" />
            </Field>
            <Text style={styles.help}>The network the engagement targets. The executor will be checked against this in the next steps.</Text>
          </>
        )}

        {step === 2 && (
          <>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.fieldLabel}>Choose the physical executor</Text>
              <Pressable onPress={fetchExecutors} hitSlop={8}><Text style={{ color: colors.accent, fontSize: fs.sm }}>↻ refresh</Text></Pressable>
            </View>
            {loadingExec ? <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} /> : null}
            {executors.map((e) => (
              <ExecutorCard key={e.device_id} e={e} selected={selected === e.device_id} onPress={() => setSelected(e.device_id)} />
            ))}
            {!loadingExec && executors.length === 0 ? <Text style={styles.help}>No devices reporting state. Check the heartbeat / WG poller.</Text> : null}
          </>
        )}

        {step === 3 && (
          <View style={[styles.verdictCard, { borderLeftColor: verdict.color }]}>
            <Text style={{ color: verdict.color, fontSize: fs.lg, fontWeight: fw.semibold }}>{verdict.title}</Text>
            <Text style={{ color: colors.text.secondary, fontSize: fs.md, marginTop: spacing.sm, lineHeight: 18 }}>{verdict.detail}</Text>
            {selectedExec && (
              <View style={{ marginTop: spacing.md, gap: 4 }}>
                <Meta k="Executor" v={selectedExec.device_id} />
                <Meta k="On Wi-Fi" v={selectedExec.wifi_ssid || "—"} />
                <Meta k="Tunnel" v={selectedExec.wg_up ? `up (${selectedExec.wg_handshake_age_s}s)` : "stale/down"} />
                <Meta k="Target" v={targetSsid || targetSubnet || "—"} />
              </View>
            )}
          </View>
        )}

        {step === 4 && (
          <Field label="Autonomy level">
            <View style={{ gap: spacing.sm }}>
              {AUTONOMY.map((a) => (
                <Pressable key={a.key} onPress={() => setAutonomy(a.key)} style={[styles.autoRow, autonomy === a.key && { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.08) }]}>
                  <Text style={{ color: autonomy === a.key ? colors.accent : colors.text.primary, fontSize: fs.base, fontWeight: fw.semibold }}>{a.label}</Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, marginTop: 2 }}>{a.hint}</Text>
                </Pressable>
              ))}
            </View>
          </Field>
        )}

        {step === 5 && (
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.fieldLabel}>Review</Text>
            <View style={styles.reviewCard}>
              <Meta k="Client" v={client} />
              <Meta k="Type" v={ENGAGEMENT_TYPES.find((t) => t.key === type)?.label || type} />
              <Meta k="Target" v={[targetSsid, targetSubnet].filter(Boolean).join(" · ") || "—"} />
              <Meta k="Executor" v={selected || "—"} />
              <Meta k="Autonomy" v={AUTONOMY.find((a) => a.key === autonomy)?.label || autonomy} />
              <Meta k="Objective #1" v={verdict.kind === "wifi" ? "Gain Wi-Fi access" : "Recon the target"} highlight={verdict.kind === "wifi" ? colors.warning : undefined} />
            </View>
          </View>
        )}
      </ScrollView>

      {/* Footer nav */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
        <Pressable onPress={() => (step === 0 ? router.back() : setStep(step - 1))} style={styles.navBtn}>
          <Text style={{ color: colors.text.secondary, fontSize: fs.base, fontWeight: fw.medium }}>{step === 0 ? "Cancel" : "Back"}</Text>
        </Pressable>
        {step < STEPS.length - 1 ? (
          <Pressable onPress={() => canNext && setStep(step + 1)} style={[styles.navBtnPrimary, !canNext && { opacity: 0.4 }]} disabled={!canNext}>
            <Text style={{ color: colors.bg.base, fontSize: fs.base, fontWeight: fw.semibold }}>Next</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => !submitting && create()} style={[styles.navBtnPrimary, submitting && { opacity: 0.6 }]} disabled={submitting}>
            {submitting ? <ActivityIndicator color={colors.bg.base} /> : <Text style={{ color: colors.bg.base, fontSize: fs.base, fontWeight: fw.semibold }}>Create engagement</Text>}
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && { backgroundColor: colors.accent }]}>
      <Text style={{ color: active ? colors.bg.base : colors.text.secondary, fontSize: fs.sm, fontWeight: active ? fw.semibold : fw.medium }}>{label}</Text>
    </Pressable>
  );
}

function Meta({ k, v, highlight }: { k: string; v: string; highlight?: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text style={{ color: colors.text.tertiary, fontSize: fs.sm }}>{k}</Text>
      <Text style={{ color: highlight || colors.text.primary, fontSize: fs.sm, fontWeight: fw.medium, flexShrink: 1, textAlign: "right", marginLeft: spacing.md }}>{v}</Text>
    </View>
  );
}

function ExecutorCard({ e, selected, onPress }: { e: Executor; selected: boolean; onPress: () => void }) {
  const c = deviceColor(e);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.execCard, { borderLeftColor: c }, selected && { backgroundColor: withAlpha(colors.accent, 0.1), borderColor: colors.accent }, pressed && { opacity: 0.9 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
        <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold, flex: 1 }}>{e.device_id}</Text>
        {selected ? <Text style={{ color: colors.accent, fontSize: fs.sm, fontWeight: fw.bold }}>✓</Text> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm }}>
        <Meta k="Wi-Fi" v={e.wifi_ssid || "—"} />
        <Meta k="WG" v={e.wg_up ? "up" : "down"} />
        {e.battery_pct != null ? <Meta k="Batt" v={`${e.battery_pct}%`} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stepRail: { flexDirection: "row", paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, backgroundColor: colors.bg.elevated, borderBottomWidth: 1, borderBottomColor: colors.border.subtle },
  stepDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gray[600] },
  stepDotActive: { backgroundColor: colors.accent },
  stepDotDone: { backgroundColor: colors.success },
  fieldLabel: { color: colors.text.secondary, fontSize: fs.sm, fontWeight: fw.semibold, textTransform: "uppercase", letterSpacing: 0.5 },
  input: { backgroundColor: colors.bg.surface, color: colors.text.primary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: spacing.md, paddingVertical: spacing.md, fontSize: fs.base },
  help: { color: colors.text.tertiary, fontSize: fs.sm, lineHeight: 17 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, backgroundColor: withAlpha(colors.text.secondary, 0.08) },
  execCard: { backgroundColor: colors.bg.elevated, borderRadius: radius.lg, borderLeftWidth: 3, borderWidth: 1, borderColor: colors.border.subtle, padding: spacing.md },
  verdictCard: { backgroundColor: colors.bg.elevated, borderRadius: radius.lg, borderLeftWidth: 3, padding: spacing.lg },
  autoRow: { backgroundColor: colors.bg.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.default, padding: spacing.md },
  reviewCard: { backgroundColor: colors.bg.elevated, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  footer: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border.subtle, backgroundColor: colors.bg.elevated },
  navBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg.surface },
  navBtnPrimary: { flex: 2, alignItems: "center", justifyContent: "center", paddingVertical: spacing.md, borderRadius: radius.md, backgroundColor: colors.accent },
});
