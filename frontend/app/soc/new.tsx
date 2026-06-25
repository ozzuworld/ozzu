// New-engagement wizard — device-FIRST + auto Wi-Fi scan. dir_1782156946277.
// Flow: Basics → Executor (pick the physical device) → Wi-Fi (the device SCANS and you pick
// the target from what it actually sees — NO typing) → Gate (on it → recon; not → gain Wi-Fi
// access first) → Autonomy → Review. The old manual SSID/subnet text boxes are gone.

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

type WifiNetwork = { ssid: string; signal: number; security: string; current?: boolean };

const ENGAGEMENT_TYPES = [
  { key: "internal_pentest", label: "Internal" },
  { key: "external_pentest", label: "External" },
  { key: "webapp", label: "Web app" },
  { key: "redteam", label: "Red team" },
  { key: "compliance", label: "Compliance" },
];

const AUTONOMY = [
  { key: "recon_only", label: "Recon only", hint: "Discovery + enumeration, no exploitation" },
  { key: "exploitation_auto", label: "Autonomous", hint: "Full autonomous run — recon through exploit" },
  { key: "exploitation_prompt", label: "Guided exploit", hint: "Autonomous recon, each exploit needs your approval" },
  { key: "full_engagement", label: "Full + post-exploit", hint: "Everything including post-exploitation" },
];

const MODELS = [
  { key: "deepseek-reasoner", label: "DeepSeek R1", hint: "DeepSeek reasoning model via API" },
  { key: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Anthropic Opus via Max subscription (zero cost)" },
];

const STEPS = ["Basics", "Access point", "Wi-Fi", "Autonomy", "Review"];

function deviceColor(e: Executor): string {
  if (!e.online) return colors.error;
  if (!e.wg_up) return colors.warning;
  return colors.success;
}

type Verdict = { kind: "ready" | "wifi" | "none"; title: string; detail: string; color: string };

export default function SOCNewScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Form
  const [client, setClient] = useState("");
  const [type, setType] = useState("internal_pentest");
  const [autonomy, setAutonomy] = useState("exploitation_auto");
  const [model, setModel] = useState("deepseek-reasoner");

  // Executor
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [loadingExec, setLoadingExec] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Wi-Fi scan
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [pickedSsid, setPickedSsid] = useState<string | null>(null);

  const selectedExec = useMemo(() => executors.find((e) => e.device_id === selected) || null, [executors, selected]);
  const pickedNet = useMemo(() => networks.find((n) => n.ssid === pickedSsid) || null, [networks, pickedSsid]);

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

  // Run the LIVE Wi-Fi scan ON the chosen device (the whole point — no typed SSIDs).
  const scanWifi = useCallback(async () => {
    if (!selected) return;
    setScanning(true); setScanError(null);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/executors/${encodeURIComponent(selected)}/wifi-scan`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `scan failed (${r.status})`);
      const nets: WifiNetwork[] = d.networks || [];
      setNetworks(nets);
      const cur = nets.find((n) => n.current);
      if (cur) setPickedSsid((p) => p ?? cur.ssid); // default-pick the network it's already on
    } catch (e: any) {
      setScanError(e?.message || "scan failed");
      setNetworks([]);
    } finally {
      setScanning(false);
    }
  }, [selected]);

  // Auto-scan the moment you land on the Wi-Fi step with a device chosen + no results yet.
  useEffect(() => {
    if (step === 2 && selected && networks.length === 0 && !scanning && !scanError) scanWifi();
  }, [step, selected, networks.length, scanning, scanError, scanWifi]);

  // Gate verdict — derived from the picked network's `current` flag (is the device ON it?).
  const verdict: Verdict = useMemo(() => {
    if (!pickedNet) return { kind: "none", title: "Pick a network", detail: "Choose the target Wi-Fi from the scan.", color: colors.text.tertiary };
    if (pickedNet.current) {
      return { kind: "ready", title: `${selected} is on "${pickedNet.ssid}"`, detail: "Already on the target network — the engagement goes straight to recon.", color: colors.success };
    }
    return {
      kind: "wifi",
      title: "Wi-Fi access becomes Objective #1",
      detail: `${selected} can see "${pickedNet.ssid}" but isn't joined. The engagement opens by gaining access to it, then flows into the real targets once on-net.`,
      color: colors.warning,
    };
  }, [pickedNet, selected]);

  const canNext = useMemo(() => {
    if (step === 0) return client.trim().length > 0;
    if (step === 1) return !!selected;
    if (step === 2) return !!pickedSsid && (verdict.kind === "ready" || verdict.kind === "wifi");
    return true;
  }, [step, client, selected, pickedSsid, verdict]);

  const create = useCallback(async () => {
    setSubmitting(true);
    try {
      const subnet = selectedExec?.lan_subnet || null;
      const target_networks = [{ ssid: pickedSsid, subnet, reachable_via: selected }];
      const body: any = {
        client_name: client.trim(),
        engagement_type: type,
        scope: { targets: subnet ? [subnet] : [], allowed: [], prohibited: [] },
        target_networks,
        executor_host: selected,
        model_override: model,
        metadata: { permission_mode: autonomy },
      };
      if (verdict.kind === "wifi") {
        body.first_objective = "gain_wifi_access";
        body.wifi_target = pickedSsid;
      }
      const r = await fetch(`${getBridgeUrl()}/soc/engagements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.id) router.replace(`/soc/${d.id}`);
      else setSubmitting(false);
    } catch (e) {
      console.error("create failed", e);
      setSubmitting(false);
    }
  }, [client, type, pickedSsid, selected, selectedExec, autonomy, model, verdict, router]);

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
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.fieldLabel}>Network access point</Text>
              <Pressable onPress={fetchExecutors} hitSlop={8}><Text style={{ color: colors.accent, fontSize: fs.sm }}>↻ refresh</Text></Pressable>
            </View>
            <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, marginTop: -spacing.sm }}>The device physically connected to the target network. Commands run on the bridge — this device relays traffic.</Text>
            {loadingExec ? <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} /> : null}
            {executors.map((e) => (
              <ExecutorCard
                key={e.device_id}
                e={e}
                selected={selected === e.device_id}
                onPress={() => { setSelected(e.device_id); setNetworks([]); setPickedSsid(null); setScanError(null); }}
              />
            ))}
            {!loadingExec && executors.length === 0 ? <Text style={styles.help}>No devices reporting state. Check the heartbeat / WG poller.</Text> : null}
          </>
        )}

        {step === 2 && (
          <>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.fieldLabel}>Wi-Fi seen by {selected}</Text>
              <Pressable onPress={scanWifi} hitSlop={8} disabled={scanning}>
                <Text style={{ color: scanning ? colors.text.disabled : colors.accent, fontSize: fs.sm }}>↻ rescan</Text>
              </Pressable>
            </View>
            {scanning ? (
              <View style={{ alignItems: "center", paddingVertical: spacing.xl, gap: spacing.sm }}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.help}>Scanning Wi-Fi on {selected}…</Text>
              </View>
            ) : scanError ? (
              <View style={[styles.verdictCard, { borderLeftColor: colors.error }]}>
                <Text style={{ color: colors.error, fontSize: fs.base, fontWeight: fw.semibold }}>Scan failed</Text>
                <Text style={{ color: colors.text.secondary, fontSize: fs.sm, marginTop: 4 }}>{scanError}</Text>
                <Pressable onPress={scanWifi} style={[styles.chip, { alignSelf: "flex-start", marginTop: spacing.sm }]}>
                  <Text style={{ color: colors.accent, fontSize: fs.sm }}>Retry scan</Text>
                </Pressable>
              </View>
            ) : networks.length === 0 ? (
              <Text style={styles.help}>No networks seen. Make sure {selected} is online with Wi-Fi up, then rescan.</Text>
            ) : (
              <View style={{ gap: spacing.sm }}>
                {networks.map((n) => (
                  <WifiRow key={n.ssid} n={n} selected={pickedSsid === n.ssid} onPress={() => setPickedSsid(n.ssid)} />
                ))}
              </View>
            )}
            {pickedNet && (
              <View style={[styles.verdictCard, { borderLeftColor: verdict.color, marginTop: spacing.sm }]}>
                <Text style={{ color: verdict.color, fontSize: fs.base, fontWeight: fw.semibold }}>{verdict.title}</Text>
                <Text style={{ color: colors.text.secondary, fontSize: fs.sm, marginTop: 4, lineHeight: 18 }}>{verdict.detail}</Text>
                <View style={{ marginTop: spacing.sm, gap: 4 }}>
                  <Meta k="Security" v={pickedNet.security} />
                  <Meta k="Joined?" v={pickedNet.current ? "yes — on it" : "not yet"} highlight={pickedNet.current ? colors.success : colors.warning} />
                </View>
              </View>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <Field label="Offense model">
              <View style={{ gap: spacing.sm }}>
                {MODELS.map((m) => (
                  <Pressable key={m.key} onPress={() => setModel(m.key)} style={[styles.autoRow, model === m.key && { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.08) }]}>
                    <Text style={{ color: model === m.key ? colors.accent : colors.text.primary, fontSize: fs.base, fontWeight: fw.semibold }}>{m.label}</Text>
                    <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, marginTop: 2 }}>{m.hint}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>
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
          </>
        )}

        {step === 4 && (
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.fieldLabel}>Review</Text>
            <View style={styles.reviewCard}>
              <Meta k="Client" v={client} />
              <Meta k="Type" v={ENGAGEMENT_TYPES.find((t) => t.key === type)?.label || type} />
              <Meta k="Access point" v={selected || "—"} />
              <Meta k="Target Wi-Fi" v={pickedSsid || "—"} />
              <Meta k="Model" v={MODELS.find((m) => m.key === model)?.label || model} highlight={model.startsWith("claude-") ? colors.accent : undefined} />
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

function WifiRow({ n, selected, onPress }: { n: WifiNetwork; selected: boolean; onPress: () => void }) {
  const bars = Math.max(1, Math.min(4, Math.round(n.signal / 25)));
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.wifiRow, selected && { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.1) }, pressed && { opacity: 0.9 }]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text style={{ color: colors.text.primary, fontSize: fs.base, fontWeight: fw.semibold }}>{n.ssid}</Text>
          {n.current ? <Text style={{ color: colors.success, fontSize: fs.xs, fontWeight: fw.bold }}>● ON THIS NETWORK</Text> : null}
        </View>
        <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, marginTop: 2 }}>
          {n.security === "open" ? "🔓 open" : `🔒 ${n.security}`} · signal {n.signal}%
        </Text>
      </View>
      <Text style={{ color: n.signal > 50 ? colors.success : colors.warning, fontSize: fs.lg, letterSpacing: 1 }}>{"▂▄▆█".slice(0, bars)}</Text>
      {selected ? <Text style={{ color: colors.accent, fontSize: fs.base, fontWeight: fw.bold, marginLeft: spacing.sm }}>✓</Text> : null}
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
  wifiRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bg.elevated, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border.subtle, padding: spacing.md },
  verdictCard: { backgroundColor: colors.bg.elevated, borderRadius: radius.lg, borderLeftWidth: 3, padding: spacing.lg },
  autoRow: { backgroundColor: colors.bg.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.default, padding: spacing.md },
  reviewCard: { backgroundColor: colors.bg.elevated, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  footer: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border.subtle, backgroundColor: colors.bg.elevated },
  navBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg.surface },
  navBtnPrimary: { flex: 2, alignItems: "center", justifyContent: "center", paddingVertical: spacing.md, borderRadius: radius.md, backgroundColor: colors.accent },
});
