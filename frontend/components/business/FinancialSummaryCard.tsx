import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { formatCOPDisplay, formatCOPCompact } from "./CostField";
import type { ProjectFinancials } from "../../lib/bridge-api";

const CATEGORY_COLORS: Record<string, string> = {
  materials: "#3B82F6",
  labor: "#F97316",
  services: "#8B5CF6",
  equipment: "#06B6D4",
  transport: "#EAB308",
  permits: "#22C55E",
  fees: "#EF4444",
  other: "#737373",
};

interface FinancialSummaryCardProps {
  financials: ProjectFinancials | null;
  loading?: boolean;
}

export function FinancialSummaryCard({ financials, loading }: FinancialSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading || !financials) return null;

  const { budget, totalEstimated, totalActual, totalIVA, byCategory, byPhase, budgetUtilization } = financials;
  const hasBudget = budget !== null && budget > 0;
  const remaining = hasBudget ? budget - totalActual : null;

  const barColor = !hasBudget ? "#06B6D4" : (budgetUtilization || 0) > 100 ? "#EF4444" : (budgetUtilization || 0) > 80 ? "#EAB308" : "#22C55E";

  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((e) => !e);
  };

  // Top 4 categories for mini bar
  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const catTotal = catEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <Pressable onPress={toggleExpand}>
      <View style={{ backgroundColor: "#1A1A1A", borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, letterSpacing: 2 }}>FINANCIALS</Text>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 11 }}>{expanded ? "▾" : "▸"}</Text>
        </View>

        {/* Budget bar */}
        {hasBudget ? (
          <View style={{ marginBottom: 10 }}>
            <ProgressBar done={totalActual} total={budget} color={barColor} height={6} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 5 }}>
              <Text style={{ color: barColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
                {formatCOPCompact(totalActual)} / {formatCOPCompact(budget)}
              </Text>
              <Text style={{ color: budgetUtilization && budgetUtilization > 100 ? "#EF4444" : "#525252", fontFamily: "monospace", fontSize: 11 }}>
                {budgetUtilization?.toFixed(0)}%
              </Text>
            </View>
          </View>
        ) : null}

        {/* Summary row */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>ESTIMATED</Text>
            <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 14 }}>{formatCOPCompact(totalEstimated)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>ACTUAL</Text>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>{formatCOPCompact(totalActual)}</Text>
          </View>
          {remaining !== null ? (
            <View style={{ flex: 1 }}>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>REMAINING</Text>
              <Text style={{ color: remaining < 0 ? "#EF4444" : "#22C55E", fontFamily: "monospace", fontSize: 14 }}>
                {remaining < 0 ? "-" : ""}{formatCOPCompact(Math.abs(remaining))}
              </Text>
            </View>
          ) : null}
        </View>

        {/* IVA */}
        {totalIVA > 0 ? (
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 8 }}>
            IVA: {formatCOPDisplay(totalIVA)}
          </Text>
        ) : null}

        {/* Category mini-bars */}
        {catEntries.length > 0 ? (
          <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 10 }}>
            {catEntries.map(([cat, val]) => (
              <View key={cat} style={{ flex: val / catTotal, backgroundColor: CATEGORY_COLORS[cat] || "#525252" }} />
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
                    <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: CATEGORY_COLORS[cat] || "#525252" }} />
                    <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 9 }}>
                      {cat}: {formatCOPCompact(val)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Phase rollup */}
            {Object.keys(byPhase).length > 0 ? (
              <View>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 9, marginBottom: 6 }}>PER-PHASE</Text>
                {Object.entries(byPhase).map(([phase, data]) => (
                  <View key={phase} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#222" }}>
                    <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10, flex: 1 }} numberOfLines={1}>{phase}</Text>
                    <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, width: 60, textAlign: "right" }}>
                      Est {formatCOPCompact(data.estimated)}
                    </Text>
                    <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 10, width: 60, textAlign: "right" }}>
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
