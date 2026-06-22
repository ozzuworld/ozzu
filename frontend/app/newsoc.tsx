// Standalone SOC engagement-creation page.
// DELIBERATELY self-contained: no TopBar, no GroupNav, no usePhoneLayout, no tab
// chrome — none of the shared layout components that were hiding the "+ New" entry
// on the SOC tab. Only RN primitives + SafeAreaView + the bridge fetch helper +
// the color tokens (pure constants, not a layout dependency). Single-screen form,
// nothing absolute-positioned over anything, so nothing can clip or cover it.
// Reachable at /newsoc and from the big button on the SOC tab. dir_1782156946277.

import { useState, useEffect, useCallback } from "react";
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { getBridgeUrl } from "../lib/bridge-api";
import { colors } from "../lib/design-tokens";

type Executor = {
  device_id: string;
  online: boolean;
  wifi_ssid: string | null;
  lan_subnet: string | null;
  wg_up: boolean;
  battery_pct: number | null;
};

const TYPES = [
  { key: "internal_pentest", label: "Internal" },
  { key: "external_pentest", label: "External" },
  { key: "webapp", label: "Web app" },
  { key: "redteam", label: "Red team" },
  { key: "compliance", label: "Compliance" },
];

const AUTONOMY = [
  { key: "recon_only", label: "Recon only", hint: "Discovery + enumeration, no exploitation" },
  { key: "exploitation_auto", label: "Autonomous", hint: "Recon → exploit, automatically" },
  { key: "full_engagement", label: "Full + post-exploit", hint: "Everything, incl. post-exploitation" },
];

export default function NewSOC() {
  const router = useRouter();

  const [client, setClient] = useState("");
  const [type, setType] = useState("internal_pentest");
  const [ssid, setSsid] = useState("");
  const [subnet, setSubnet] = useState("");
  const [autonomy, setAutonomy] = useState("exploitation_auto");

  const [executors, setExecutors] = useState<Executor[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingExec, setLoadingExec] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutors = useCallback(async () => {
    setLoadingExec(true);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/executors`);
      const d = await r.json();
      setExecutors(d.executors || []);
    } catch {
      /* leave empty — creation still works without a pre-assigned executor */
    } finally {
      setLoadingExec(false);
    }
  }, []);

  useEffect(() => { fetchExecutors(); }, [fetchExecutors]);

  const create = useCallback(async () => {
    if (!client.trim()) { setError("Enter a client / target name first."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const exec = executors.find((e) => e.device_id === selected) || null;
      const onSsid = !!(ssid && exec?.wifi_ssid && exec.wifi_ssid.trim().toLowerCase() === ssid.trim().toLowerCase());
      const onSubnet = !!(subnet && exec?.lan_subnet && exec.lan_subnet === subnet.trim());
      const needsWifi = !!exec && exec.online && !(onSsid || onSubnet);

      const body: any = {
        client_name: client.trim(),
        engagement_type: type,
        scope: { targets: subnet.trim() ? [subnet.trim()] : [], allowed: [], prohibited: [] },
        target_networks: [{ ssid: ssid.trim() || null, subnet: subnet.trim() || null, reachable_via: selected }],
        executor_host: selected,
        metadata: { permission_mode: autonomy },
      };
      if (needsWifi) {
        body.first_objective = "gain_wifi_access";
        body.wifi_target = ssid.trim();
      }

      const r = await fetch(`${getBridgeUrl()}/soc/engagements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.id) router.replace(`/soc/${d.id}`);
      else { setError(d.error || "Server did not return an engagement id."); setSubmitting(false); }
    } catch (e: any) {
      setError(`Create failed: ${e?.message || String(e)}`);
      setSubmitting(false);
    }
  }, [client, type, ssid, subnet, autonomy, selected, executors, router]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.base }} edges={["top", "bottom"]}>
      <StatusBar style="light" />

      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={14} style={{ width: 60 }}>
          <Text style={{ color: colors.text.secondary, fontSize: 16 }}>‹ Back</Text>
        </Pressable>
        <Text style={s.title}>New Engagement</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 18 }} keyboardShouldPersistTaps="handled">
        <Section label="Client / target name">
          <TextInput
            value={client} onChangeText={setClient}
            placeholder="e.g. Edificio Laura" placeholderTextColor={colors.text.disabled}
            style={s.input}
          />
        </Section>

        <Section label="Engagement type">
          <View style={s.wrap}>
            {TYPES.map((t) => (
              <Pressable key={t.key} onPress={() => setType(t.key)} style={[s.chip, type === t.key && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                <Text style={{ color: type === t.key ? colors.bg.base : colors.text.secondary, fontWeight: "600", fontSize: 13 }}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section label="Target Wi-Fi (SSID)">
          <TextInput
            value={ssid} onChangeText={setSsid}
            placeholder="e.g. EDIFICIO LAURA" placeholderTextColor={colors.text.disabled}
            autoCapitalize="characters" style={s.input}
          />
        </Section>

        <Section label="Target subnet (optional)">
          <TextInput
            value={subnet} onChangeText={setSubnet}
            placeholder="e.g. 192.168.1.0/24" placeholderTextColor={colors.text.disabled}
            autoCapitalize="none" style={s.input}
          />
        </Section>

        <Section label="Executor device">
          {loadingExec ? <ActivityIndicator color={colors.accent} /> : null}
          {!loadingExec && executors.length === 0 ? (
            <Text style={{ color: colors.text.disabled, fontSize: 13 }}>No devices reporting. You can still create — assign later.</Text>
          ) : null}
          <View style={{ gap: 8 }}>
            {executors.map((e) => {
              const sel = selected === e.device_id;
              const dot = !e.online ? colors.error : !e.wg_up ? colors.warning : colors.success;
              return (
                <Pressable key={e.device_id} onPress={() => setSelected(sel ? null : e.device_id)} style={[s.exec, sel && { borderColor: colors.accent }]}>
                  <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot }} />
                  <Text style={{ color: colors.text.primary, fontWeight: "600", flex: 1, marginLeft: 10 }}>{e.device_id}</Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: 12 }}>
                    {e.wifi_ssid || "—"}{e.battery_pct != null ? ` · ${e.battery_pct}%` : ""}
                  </Text>
                  {sel ? <Text style={{ color: colors.accent, marginLeft: 8, fontWeight: "700" }}>✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
          <Pressable onPress={fetchExecutors} hitSlop={8} style={{ alignSelf: "flex-start", marginTop: 6 }}>
            <Text style={{ color: colors.accent, fontSize: 13 }}>↻ refresh devices</Text>
          </Pressable>
        </Section>

        <Section label="Autonomy">
          <View style={{ gap: 8 }}>
            {AUTONOMY.map((a) => {
              const sel = autonomy === a.key;
              return (
                <Pressable key={a.key} onPress={() => setAutonomy(a.key)} style={[s.auto, sel && { borderColor: colors.accent }]}>
                  <Text style={{ color: sel ? colors.accent : colors.text.primary, fontWeight: "600", fontSize: 15 }}>{a.label}</Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: 12, marginTop: 2 }}>{a.hint}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {error ? <Text style={{ color: colors.error, fontSize: 13 }}>{error}</Text> : null}

        <Pressable onPress={() => !submitting && create()} disabled={submitting} style={[s.create, submitting && { opacity: 0.6 }]}>
          {submitting
            ? <ActivityIndicator color={colors.bg.base} />
            : <Text style={{ color: colors.bg.base, fontSize: 17, fontWeight: "800" }}>Create Engagement</Text>}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.text.secondary, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.subtle },
  title: { color: colors.text.primary, fontSize: 17, fontWeight: "700" },
  input: { backgroundColor: colors.bg.surface, color: colors.text.primary, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.bg.surface, borderWidth: 1, borderColor: colors.border.default },
  exec: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bg.elevated, borderRadius: 12, borderWidth: 1, borderColor: colors.border.subtle, padding: 14 },
  auto: { backgroundColor: colors.bg.elevated, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, padding: 14 },
  create: { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 18, alignItems: "center", marginTop: 8 },
});
