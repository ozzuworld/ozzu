import { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { colors } from "../../lib/design-tokens";
import { fetchSecopWorker, setSecopWorker, type SecopWorkerState } from "../../lib/bridge-api";

// Play/pause control for the SECOP pre-analysis worker (dir_1784646309888). It runs on King
// Kazuma's Claude Max quota, so it's manually driven: this card shows how many tenders are
// still pending and the estimated token cost, and lets him start/stop it from the app.
function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color, fontSize: 19, fontWeight: "700", fontFamily: "monospace" }}>{value}</Text>
      <Text style={{ color: colors.text.tertiary, fontSize: 9.5, marginTop: 3, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

export function WorkerControl() {
  const [state, setState] = useState<SecopWorkerState | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const s = await fetchSecopWorker();
      if (mounted.current) setState(s);
    } catch { /* keep last known state on a transient failure */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const iv = setInterval(load, 12000); // refresh the backlog count as the worker chews through it
    return () => { mounted.current = false; clearInterval(iv); };
  }, [load]);

  const apply = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await setSecopWorker(enabled);
      if (mounted.current) {
        setState((prev) => (prev ? { ...prev, enabled: r.enabled, pending: r.pending, hard_off: r.hard_off } : prev));
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "No se pudo cambiar el estado del analizador.");
    } finally {
      if (mounted.current) setBusy(false);
      load();
    }
  }, [load]);

  const onToggle = useCallback(() => {
    if (!state || busy) return;
    if (state.enabled) { apply(false); return; } // pausing is safe → no confirmation
    Alert.alert(
      "Iniciar análisis",
      `Se analizarán ~${state.pending} licitación${state.pending === 1 ? "" : "es"} usando tu plan Claude Max ` +
        `(~${fmtTokens(state.est_tokens)} tokens estimados). ¿Continuar?`,
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Iniciar", style: "default", onPress: () => apply(true) },
      ]
    );
  }, [state, busy, apply]);

  const running = !!state?.enabled;
  const hardOff = !!state?.hard_off;
  const accent = hardOff ? colors.error : running ? colors.success : colors.brand.amber;
  const btnColor = running ? colors.brand.amber : colors.success;

  return (
    <View
      style={{
        backgroundColor: colors.gray[800], borderRadius: 12,
        borderLeftWidth: 3, borderLeftColor: accent,
        borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
        padding: 14, marginBottom: 12,
      }}
    >
      {/* Header: icon + title/subtitle + status pill */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 13 }}>
        <Text style={{ fontSize: 20 }}>🧠</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.gray[50], fontSize: 14, fontWeight: "600" }}>Analizador</Text>
          <Text style={{ color: colors.text.tertiary, fontSize: 10.5, marginTop: 1 }}>Pre-analiza licitaciones con IA</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: accent + "1a", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent }} />
          <Text style={{ color: accent, fontSize: 10, fontWeight: "700" }}>{hardOff ? "Bloqueado" : running ? "Activo" : "En pausa"}</Text>
        </View>
      </View>

      {/* Stats: pending (focal, cyan) · est tokens · already analyzed */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
        <Stat value={state ? String(state.pending) : "…"} label="por analizar" color={colors.accentLight} />
        <Stat value={state ? `~${fmtTokens(state.est_tokens)}` : "…"} label="tokens est." color={colors.gray[50]} />
        <Stat value={state?.analyzed != null ? String(state.analyzed) : "—"} label="analizadas" color={colors.gray[400]} />
      </View>

      {/* Primary action — start (green) / pause (amber) */}
      <Pressable
        onPress={onToggle}
        disabled={!state || busy || hardOff}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          backgroundColor: btnColor + (pressed ? "33" : "18"),
          borderColor: btnColor + "66", borderWidth: 1, borderRadius: 10, paddingVertical: 11,
          opacity: !state || hardOff ? 0.5 : 1,
        })}
      >
        {busy ? (
          <ActivityIndicator size="small" color={btnColor} />
        ) : (
          <Text style={{ color: btnColor, fontSize: 13.5, fontWeight: "700" }}>
            {hardOff ? "Deshabilitado (SECOP_WORKER=off)" : running ? "⏸  Pausar" : "▶  Iniciar análisis"}
          </Text>
        )}
      </Pressable>

      {/* Quota reminder — only when paused (starting spends the Max plan) */}
      {!running && !hardOff ? (
        <Text style={{ color: colors.text.tertiary, fontSize: 10, marginTop: 9, textAlign: "center" }}>
          ⚡ Consume tu plan Claude Max mientras está activo
        </Text>
      ) : null}
    </View>
  );
}
