import { View, Text, Pressable, Linking } from "react-native";
import { colors } from "../../lib/design-tokens";
import { formatSalary, postedAgo, sourceStyle, roleEmoji, accentFor } from "../../lib/jobs-format";
import type { Job, JobDecision } from "../../lib/bridge-api";

// One remote-job card. Tapping the body opens the listing (apply on the source platform).
// Actions adapt to triage state: pending → Descartar / Guardar; saved → Descartar / Apliqué;
// applied → a static ✓ Aplicado. The colored left border marks LatAm-reachable roles (cyan).
export function JobCard({ job, onDecide }: { job: Job; onDecide: (d: JobDecision) => void }) {
  const emoji = roleEmoji(job.title, job.tags, job.matched_skills);
  const salary = formatSalary(job.salary_min, job.salary_max, job.salary_currency, job.salary_period);
  const ago = postedAgo(job.posted_at);
  const src = sourceStyle(job.source);
  const accent = accentFor(job.latam_reachable, job.source);
  const skills = (job.matched_skills || []).slice(0, 3);
  const applied = job.decision === "applied";
  const saved = job.decision === "saved";

  const open = () => {
    const u = job.apply_url || job.url;
    if (u) Linking.openURL(u).catch(() => {});
  };

  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 12, borderLeftWidth: 3, borderLeftColor: accent, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
      <Pressable onPress={open} style={({ pressed }) => ({ padding: 14, opacity: pressed ? 0.9 : 1 })}>
        {/* Header: role emoji + title + company + posted-ago */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <Text style={{ fontSize: 20 }}>{emoji}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[50], fontSize: 14, fontWeight: "600" }} numberOfLines={1}>{job.title || "—"}</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: 10.5 }} numberOfLines={1}>{job.company || "—"}</Text>
          </View>
          {ago ? <Text style={{ color: colors.text.tertiary, fontSize: 10.5 }}>{ago}</Text> : null}
        </View>

        {/* Excerpt */}
        {job.excerpt ? (
          <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>{job.excerpt}</Text>
        ) : null}

        {/* Metadata: salary · source · LatAm · top matched skills */}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 }}>
          {salary ? (
            <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>{salary}</Text>
          ) : null}
          <View style={{ backgroundColor: src.color + "1a", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>
            <Text style={{ color: src.color, fontSize: 10, fontWeight: "700" }}>{src.label}</Text>
          </View>
          {job.latam_reachable ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
              <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600" }}>LatAm</Text>
            </View>
          ) : null}
          {skills.map((s) => (
            <View key={s} style={{ backgroundColor: colors.gray[700], borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: colors.gray[200], fontSize: 9.5 }}>{s}</Text>
            </View>
          ))}
        </View>
      </Pressable>

      {/* Actions */}
      {applied ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <View style={{ backgroundColor: colors.success + "18", borderColor: colors.success + "55", borderWidth: 1, borderRadius: 9, paddingVertical: 8, alignItems: "center" }}>
            <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>✓ Aplicado</Text>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
          <Pressable onPress={() => onDecide("dismissed")} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? colors.error + "22" : "transparent", borderColor: colors.error + "55", borderWidth: 1, borderRadius: 9, paddingVertical: 8, alignItems: "center" })}>
            <Text style={{ color: colors.error, fontSize: 12, fontWeight: "700" }}>Descartar</Text>
          </Pressable>
          <Pressable onPress={() => onDecide(saved ? "applied" : "saved")} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? colors.success + "33" : colors.success + "18", borderColor: colors.success + "66", borderWidth: 1, borderRadius: 9, paddingVertical: 8, alignItems: "center" })}>
            <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>{saved ? "Apliqué" : "Guardar"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
