// FindingsTab — severity-bucketed findings list.
// Bucket pills at top show counts; sections collapsible with Critical+High
// expanded by default.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
} from "../../lib/design-tokens";
import { FindingRow, type FindingRowData } from "./FindingRow";
import { SeverityPill } from "./SeverityPill";
import { SEVERITY_ORDER, severityColor } from "./phaseColors";

interface FindingsTabProps {
  findings: FindingRowData[];
  onFindingPress?: (finding: FindingRowData) => void;
}

export function FindingsTab({ findings, onFindingPress }: FindingsTabProps) {
  const buckets = useMemo(() => {
    const m: Record<string, FindingRowData[]> = {};
    for (const sev of SEVERITY_ORDER) m[sev] = [];
    for (const f of findings) {
      const key = (f.severity || "info").toLowerCase();
      if (m[key]) m[key].push(f);
      else m["info"].push(f);
    }
    return m;
  }, [findings]);

  const [open, setOpen] = useState<Record<string, boolean>>({
    critical: true,
    high: true,
    medium: false,
    low: false,
    info: false,
  });

  const toggle = (k: string) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  return (
    <View style={{ flex: 1 }}>
      {/* Bucket counts row (always visible) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs }}
      >
        {SEVERITY_ORDER.map((sev) => (
          <SeverityPill
            key={sev}
            severity={sev}
            count={buckets[sev].length}
            selected={open[sev]}
            onPress={() => toggle(sev)}
          />
        ))}
      </ScrollView>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm }}
      >
        {findings.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm, textAlign: "center", marginTop: spacing.xl }}>
            No findings yet
          </Text>
        ) : (
          SEVERITY_ORDER.filter((sev) => buckets[sev].length > 0).map((sev) => {
            const list = buckets[sev];
            const isOpen = open[sev];
            const sevColor = severityColor(sev);
            return (
              <View key={sev}>
                <Pressable
                  onPress={() => toggle(sev)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: colors.gray[800],
                    borderRadius: radius.md,
                    borderLeftWidth: 3,
                    borderLeftColor: sevColor,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm + 2,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm, marginRight: spacing.sm }}>
                    {isOpen ? "▼" : "▶"}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      color: sevColor,
                      fontSize: fontSize.md,
                      fontWeight: fontWeight.bold,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {sev}
                  </Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm, fontFamily: "monospace", fontWeight: fontWeight.semibold }}>
                    {list.length}
                  </Text>
                </Pressable>
                {isOpen ? (
                  <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                    {list.map((f) => (
                      <FindingRow key={f.id} finding={f} onPress={onFindingPress} />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
