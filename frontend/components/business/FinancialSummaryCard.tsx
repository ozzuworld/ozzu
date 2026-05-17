import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { formatCOPDisplay, formatCOPCompact } from "./CostField";
import type { ProjectFinancials } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
const CATEGORY_COLORS: Record<string, string> = {
  materials: colors.brand.blue,
  labor: colors.brand.orange,
  services: "#8B5CF6",
  equipment: colors.accent,
  transport: colors.brand.amberDeep,
  permits: colors.success,
  fees: colors.error,
  other: colors.gray[300],
};

interface FinancialSummaryCardProps {
  financials: ProjectFinancials | null;
  loading?: boolean;
}

export function FinancialSummaryCard({ financials, loading }: FinancialSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading || !financials) return null;

  const { budget, totalEstimated, totalActual, totalIVA, verifiedTotal, unverifiedTotal, verifiedCount, unverifiedCount, byCategory, byPhase, budgetUtilization } = financials;
  const hasBudget = budget !== null && budget > 0;
  const remaining = hasBudget ? budget - totalActual : null;

  const barColor = !hasBudget ? colors.accent : (budgetUtilization || 0) > 100 ? colors.error : (budgetUtilization || 0) > 80 ? colors.brand.amberDeep : colors.success;

  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((e) => !e);
  };

  // Top 4 categories for mini bar
  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const catTotal = catEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <Pressable onPress={toggleExpand}>
      <View style={{ backgroundColor: colors.gray[800], borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, letterSpacing: 2 }}>FINANCIALS</Text>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11 }}>{expanded ? "▾" : "▸"}</Text>
        </View>

        {/* Budget bar */}
        {hasBudget ? (
          <View style={{ marginBottom: 10 }}>
            <ProgressBar done={totalActual} total={budget} color={barColor} height={6} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 5 }}>
              <Text style={{ color: barColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
                {formatCOPCompact(totalActual)} / {formatCOPCompact(budget)}
              </Text>
              <Text style={{ color: budgetUtilization && budgetUtilization > 100 ? colors.error : colors.gray[400], fontFamily: "monospace", fontSize: 11 }}>
                {budgetUtilization?.toFixed(0)}%
              </Text>
            </View>
          </View>
        ) : null}

        {/* Summary row */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>ESTIMATED</Text>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 14 }}>{formatCOPCompact(totalEstimated)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>ACTUAL</Text>
            <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>{formatCOPCompact(totalActual)}</Text>
          </View>
          {remaining !== null ? (
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>REMAINING</Text>
              <Text style={{ color: remaining < 0 ? colors.error : colors.success, fontFamily: "monospace", fontSize: 14 }}>
                {remaining < 0 ? "-" : ""}{formatCOPCompact(Math.abs(remaining))}
              </Text>
            </View>
          ) : null}
        </View>

        {/* IVA */}
        {totalIVA > 0 ? (
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 8 }}>
            IVA: {formatCOPDisplay(totalIVA)}
          </Text>
        ) : null}

        {/* Verified vs Unverified */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success }} />
            <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 9 }}>
              {formatCOPCompact(verifiedTotal || 0)}
            </Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 8 }}>
              ({verifiedCount || 0})
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.brand.amberDeep }} />
            <Text style={{ color: colors.brand.amberDeep, fontFamily: "monospace", fontSize: 9 }}>
              {formatCOPCompact(unverifiedTotal || 0)}
            </Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 8 }}>
              ({unverifiedCount || 0})
            </Text>
          </View>
        </View>

        {/* Category mini-bars */}
        {catEntries.length > 0 ? (
          <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 10 }}>
            {catEntries.map(([cat, val]) => (
              <View key={cat} style={{ flex: val / catTotal, backgroundColor: CATEGORY_COLORS[cat] || colors.gray[400] }} />
            ))}
          </View>
        ) : null}

        {/* Expanded: phase rollup table */}
        {expanded ? (
          <View style={{ marginTop: 12 }}>
            {/* Category legend */}
            {catEntries.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {catEntries.map(([cat, val]) => (
                  <View key={cat} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: CATEGORY_COLORS[cat] || colors.gray[400] }} />
                    <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 9 }}>
                      {cat}: {formatCOPCompact(val)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Phase rollup */}
            {Object.keys(byPhase).length > 0 ? (
              <View>
                <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 9, marginBottom: 6 }}>PER-PHASE</Text>
                {Object.entries(byPhase).map(([phase, data]) => (
                  <View key={phase} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#222" }}>
                    <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 10, flex: 1 }} numberOfLines={1}>{phase}</Text>
                    <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, width: 60, textAlign: "right" }}>
                      Est {formatCOPCompact(data.estimated)}
                    </Text>
                    <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 10, width: 60, textAlign: "right" }}>
                      {formatCOPCompact(data.actual)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
