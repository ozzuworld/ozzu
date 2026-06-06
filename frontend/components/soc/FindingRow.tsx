// FindingRow — one row in the Findings tab list. Severity left-border,
// title, affected asset, CVSS pill, CVE refs, MITRE technique tags.

import { Pressable, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";
import { severityColor } from "./phaseColors";

export interface FindingRowData {
  id: number;
  severity: string;
  title: string;
  affected_asset?: string | null;
  cvss_score?: number | null;
  refs?: string[] | null;
  mitre_attack?: string[] | null;
  discovered_at?: string | null;
}

interface FindingRowProps {
  finding: FindingRowData;
  onPress?: (finding: FindingRowData) => void;
}

function cveFromRefs(refs?: string[] | null): string | null {
  if (!refs) return null;
  for (const r of refs) {
    const m = String(r).match(/CVE-\d{4}-\d+/i);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function fmtCvss(v: unknown): string | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(1);
}

export function FindingRow({ finding, onPress }: FindingRowProps) {
  const color = severityColor(finding.severity);
  const cve = cveFromRefs(finding.refs);
  const techniques = Array.isArray(finding.mitre_attack) ? finding.mitre_attack.slice(0, 2) : [];
  const cvssLabel = fmtCvss(finding.cvss_score);

  return (
    <Pressable
      onPress={() => onPress?.(finding)}
      style={({ pressed }) => ({
        backgroundColor: colors.gray[800],
        borderRadius: radius.md,
        borderLeftWidth: 3,
        borderLeftColor: color,
        padding: spacing.md,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.04)",
        opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* Title + CVSS */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.xs }}>
        <Text
          style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}
          numberOfLines={2}
        >
          {finding.title || "(untitled)"}
        </Text>
        {cvssLabel != null ? (
          <View
            style={{
              backgroundColor: withAlpha(color, 0.18),
              borderRadius: radius.sm,
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
              marginLeft: spacing.sm,
            }}
          >
            <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.bold, fontFamily: "monospace" }}>
              CVSS {cvssLabel}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Asset */}
      {finding.affected_asset ? (
        <Text
          style={{ color: colors.text.secondary, fontSize: fontSize.xs, fontFamily: "monospace", marginBottom: spacing.sm }}
          numberOfLines={1}
        >
          {finding.affected_asset}
        </Text>
      ) : null}

      {/* Refs row */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {cve ? (
          <RefChip label={cve} color={colors.brand.purple} />
        ) : null}
        {techniques.map((t) => (
          <RefChip key={t} label={t} color={colors.brand.cyan} />
        ))}
      </View>
    </Pressable>
  );
}

function RefChip({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        backgroundColor: withAlpha(color, 0.14),
        borderRadius: radius.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.medium, fontFamily: "monospace" }}>
        {label}
      </Text>
    </View>
  );
}
