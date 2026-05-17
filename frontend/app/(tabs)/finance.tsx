import { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { TransactionCard } from "../../components/finance/TransactionCard";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { getBridgeUrl } from "../../lib/bridge-api";
import { formatCOP } from "../../lib/format";

import { colors } from "../../lib/design-tokens";
// Matches actual API response from GET /api/finance/summary
type MonthRow = {
  month: string; // "YYYY-MM"
  income: string;
  expenses: string;
  count: string;
};

type TypeRow = {
  type: string;
  count: string;
  total: string;
};

type SummaryResponse = {
  monthly: MonthRow[];
  last_known_balance: string | null;
  this_month_by_type: TypeRow[];
};

type Transaction = {
  id: string;
  type: string;
  merchant: string;
  date: string;
  amount: number;
};

function BarChart({ months }: { months: MonthRow[] }) {
  if (!months || months.length === 0) return null;

  const values = months.map((m) => parseFloat(m.expenses) || 0);
  const maxExpense = Math.max(...values, 1);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  return (
    <View style={{ marginTop: 12, gap: 8 }}>
      {months.map((m, i) => {
        const expenses = parseFloat(m.expenses) || 0;
        const ratio = expenses / maxExpense;
        const monthIndex = new Date(`${m.month}-01`).getMonth();
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.gray[400], fontSize: 10, width: 28, fontFamily: "monospace" }}>
              {monthNames[monthIndex]}
            </Text>
            <View style={{ flex: 1, height: 18, backgroundColor: colors.gray[800], borderRadius: 4, overflow: "hidden" }}>
              <View
                style={{
                  width: `${Math.max(ratio * 100, 2)}%`,
                  height: "100%",
                  backgroundColor: ratio > 0.8 ? colors.error : ratio > 0.5 ? colors.brand.amber : colors.accent,
                  borderRadius: 4,
                }}
              />
            </View>
            <Text style={{ color: colors.gray[400], fontSize: 10, width: 72, textAlign: "right", fontFamily: "monospace" }}>
              {formatCOP(expenses)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Stat({ label, value, color, signed }: { label: string; value: number; color: string; signed?: boolean }) {
  const sign = signed ? (value >= 0 ? "+" : "−") : "";
  const display = signed ? `${sign}${formatCOP(Math.abs(value))}` : formatCOP(Math.abs(value));
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.gray[850],
        borderRadius: 10,
        padding: 12,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.04)",
      }}
    >
      <Text style={{ color: colors.gray[500], fontSize: 9, fontWeight: "700", letterSpacing: 1.5, marginBottom: 4 }}>
        {label}
      </Text>
      <Text
        style={{ color, fontSize: 15, fontWeight: "bold", fontFamily: "monospace" }}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {display}
      </Text>
    </View>
  );
}

export default function FinanceScreen() {
  const { insets } = usePhoneLayout();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingTx, setLoadingTx] = useState(true);
  const [errorSummary, setErrorSummary] = useState<string | null>(null);
  const [errorTx, setErrorTx] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const hPad = Math.max(16, insets.left, insets.right);

  async function fetchSummary() {
    try {
      setErrorSummary(null);
      const res = await fetch(`${getBridgeUrl()}/api/finance/summary`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data);
    } catch (e: any) {
      setErrorSummary(e.message || "Failed to load summary");
    } finally {
      setLoadingSummary(false);
    }
  }

  async function fetchTransactions() {
    try {
      setErrorTx(null);
      const res = await fetch(`${getBridgeUrl()}/api/finance/transactions?limit=30`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTransactions(Array.isArray(data) ? data : data.transactions || []);
    } catch (e: any) {
      setErrorTx(e.message || "Failed to load transactions");
    } finally {
      setLoadingTx(false);
    }
  }

  useEffect(() => {
    fetchSummary();
    fetchTransactions();
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    setLoadingSummary(true);
    setLoadingTx(true);
    await Promise.all([fetchSummary(), fetchTransactions()]);
    setRefreshing(false);
  }

  // Derive current month stats from monthly array
  const currentMonthStr = new Date().toISOString().substring(0, 7); // "YYYY-MM"
  const currentMonthRow = summary?.monthly?.find((m) => m.month === currentMonthStr);
  const currentExpenses = parseFloat(currentMonthRow?.expenses || "0");
  const currentIncome = parseFloat(currentMonthRow?.income || "0");
  const balance = summary?.last_known_balance ? parseFloat(summary.last_known_balance) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <TopBar
        left={
          <Text style={{ color: colors.brand.amber, fontSize: 22, fontWeight: "bold", letterSpacing: 2 }}>
            OZZU
          </Text>
        }
      />

      <View style={{ height: 1, backgroundColor: colors.gray[800], marginHorizontal: hPad }} />

      <GroupNav group="me" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: hPad, paddingBottom: Math.max(24, insets.bottom), gap: 16 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        }
      >
        {/* ── HERO: balance is the focal point ── */}
        <View
          style={{
            backgroundColor: colors.gray[800],
            borderRadius: 14,
            borderLeftWidth: 3,
            borderLeftColor: colors.brand.amber,
            padding: 18,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.04)",
          }}
        >
          <Text style={{ color: colors.gray[400], fontSize: 10, fontWeight: "700", letterSpacing: 2, marginBottom: 6 }}>
            LAST KNOWN BALANCE
          </Text>
          {loadingSummary ? (
            <Text style={{ color: colors.gray[400], fontSize: 13 }}>Loading…</Text>
          ) : errorSummary ? (
            <Text style={{ color: colors.error, fontSize: 12 }}>{errorSummary}</Text>
          ) : balance !== null ? (
            <Text
              style={{ color: colors.brand.amber, fontSize: 32, fontWeight: "bold", fontFamily: "monospace" }}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {formatCOP(balance)}
            </Text>
          ) : (
            <Text style={{ color: colors.gray[300], fontSize: 18, fontFamily: "monospace" }}>—</Text>
          )}
          <Text style={{ color: colors.gray[500], fontSize: 11, marginTop: 6 }}>
            {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}
          </Text>
        </View>

        {/* ── This month: out / in / net (compact 3-up) ── */}
        {summary && !loadingSummary ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Stat label="OUT" value={currentExpenses} color={colors.error} />
            <Stat label="IN" value={currentIncome} color={colors.success} />
            <Stat
              label="NET"
              value={currentIncome - currentExpenses}
              color={currentIncome - currentExpenses >= 0 ? colors.success : colors.error}
              signed
            />
          </View>
        ) : null}

        {/* ── Last 6 months (secondary, demoted) ── */}
        {summary && summary.monthly && summary.monthly.length > 0 ? (
          <View
            style={{
              backgroundColor: colors.gray[850],
              borderRadius: 12,
              padding: 14,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.04)",
            }}
          >
            <Text style={{ color: colors.gray[400], fontSize: 10, fontWeight: "700", letterSpacing: 1.5, marginBottom: 8 }}>
              LAST 6 MONTHS · EXPENSES
            </Text>
            <BarChart months={summary.monthly} />
          </View>
        ) : null}

        {/* ── Recent transactions: ProjectCard-style cards ── */}
        <View>
          <Text style={{ color: colors.gray[400], fontSize: 10, fontWeight: "700", letterSpacing: 2, marginBottom: 10, marginLeft: 2 }}>
            RECENT TRANSACTIONS
          </Text>
          {loadingTx ? (
            <Text style={{ color: colors.gray[400], fontSize: 13, marginLeft: 2 }}>Loading…</Text>
          ) : errorTx ? (
            <Text style={{ color: colors.error, fontSize: 12, marginLeft: 2 }}>{errorTx}</Text>
          ) : transactions.length === 0 ? (
            <Text style={{ color: colors.gray[500], fontSize: 12, marginLeft: 2 }}>No transactions</Text>
          ) : (
            transactions.map((tx, i) => <TransactionCard key={tx.id || i} tx={tx} />)
          )}
        </View>
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
