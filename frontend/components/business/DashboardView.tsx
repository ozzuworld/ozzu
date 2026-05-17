import { useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useDashboardMetrics } from "../../lib/business-hooks";
import { formatCurrency } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;
const PERIODS = ["month", "quarter", "year", "all"] as const;

export function DashboardView() {
  const [period, setPeriod] = useState<string>("month");
  const { metrics, loading } = useDashboardMetrics(period);

  if (loading && !metrics) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 40 }}>
        <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading metrics...</Text>
      </View>
    );
  }

  const m = metrics;
  const plColor = (m?.netPL ?? 0) >= 0 ? colors.success : colors.error;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      {/* Period selector */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
        {PERIODS.map((p) => (
          <Pressable
            key={p}
            onPress={() => setPeriod(p)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: period === p ? ACCENT + "22" : colors.gray[800],
              borderWidth: 1,
              borderColor: period === p ? ACCENT + "44" : "rgba(255,255,255,0.06)",
            }}
          >
            <Text style={{ color: period === p ? ACCENT : colors.gray[300], fontFamily: "monospace", fontSize: 10, fontWeight: "bold", textTransform: "uppercase" }}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Key metrics 2x2 grid */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <MetricCard label="REVENUE" value={formatCurrency(m?.totalRevenue, "USD")} color=colors.success />
        <MetricCard label="EXPENSES" value={formatCurrency(m?.totalExpenses, "COP")} color=colors.brand.amber />
      </View>
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
        <MetricCard label="NET P&L" value={formatCurrency(m?.netPL, "USD")} color={plColor} />
        <MetricCard label="SHIPMENTS" value={String(m?.activeShipments ?? 0)} color={ACCENT} subtitle={shipmentSummary(m?.shipmentsByStatus)} />
      </View>

      {/* Previous period comparison */}
      {m?.previousPeriodPL != null && (
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>VS PREVIOUS PERIOD</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 12 }}>Previous P&L</Text>
            <Text style={{ color: m.previousPeriodPL >= 0 ? colors.success : colors.error, fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>
              {formatCurrency(m.previousPeriodPL, "USD")}
            </Text>
          </View>
        </View>
      )}

      {/* Revenue vs Expenses bar */}
      {m && (m.totalRevenue > 0 || m.totalExpenses > 0) && (
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 12 }}>REVENUE VS EXPENSES</Text>
          <BarRow label="Revenue" value={m.totalRevenue} max={Math.max(m.totalRevenue, m.totalExpenses)} color=colors.success currency="USD" />
          <BarRow label="Expenses" value={m.totalExpenses} max={Math.max(m.totalRevenue, m.totalExpenses)} color=colors.brand.amber currency="COP" />
        </View>
      )}

      {/* Pending payments */}
      {m && m.pendingPayments > 0 && (
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>PENDING PAYMENTS</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 12 }}>{m.pendingPayments} invoices outstanding</Text>
            <Text style={{ color: colors.brand.amberDeep, fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>{formatCurrency(m.pendingPaymentAmount, "USD")}</Text>
          </View>
        </View>
      )}

      {/* Top buyers */}
      {m && m.topBuyers.length > 0 && (
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 10 }}>TOP BUYERS</Text>
          {m.topBuyers.map((b, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: i < m.topBuyers.length - 1 ? 1 : 0, borderBottomColor: "rgba(255,255,255,0.04)" }}>
              <View>
                <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12 }}>{b.name}</Text>
                {b.company && <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{b.company}</Text>}
              </View>
              <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>{formatCurrency(b.revenue, "USD")}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Empty state */}
      {m && m.totalRevenue === 0 && m.totalExpenses === 0 && m.activeShipments === 0 && (
        <View style={{ alignItems: "center", paddingVertical: 40 }}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>📊</Text>
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 13 }}>No data yet for this period</Text>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, marginTop: 4 }}>Create shipments & invoices to see metrics</Text>
        </View>
      )}
    </ScrollView>
  );
}

function MetricCard({ label, value, color, subtitle }: { label: string; value: string; color: string; subtitle?: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>{label}</Text>
      <Text style={{ color, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{value}</Text>
      {subtitle && <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 4 }}>{subtitle}</Text>}
    </View>
  );
}

function BarRow({ label, value, max, color, currency }: { label: string; value: number; max: number; color: string; currency: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11 }}>{label}</Text>
        <Text style={{ color, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{formatCurrency(value, currency)}</Text>
      </View>
      <View style={{ height: 6, backgroundColor: "#262626", borderRadius: 3 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: color, width: `${Math.max(pct, 2)}%` }} />
      </View>
    </View>
  );
}

function shipmentSummary(byStatus?: Record<string, number>): string {
  if (!byStatus) return "";
  const parts: string[] = [];
  if (byStatus.preparing) parts.push(`${byStatus.preparing} prep`);
  if (byStatus.in_transit) parts.push(`${byStatus.in_transit} transit`);
  if (byStatus.arrived) parts.push(`${byStatus.arrived} arrived`);
  return parts.join(" · ");
}
