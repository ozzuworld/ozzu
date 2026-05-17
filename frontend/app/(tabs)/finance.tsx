import { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../../components/StatusBadge";
import HamburgerMenu from "../../components/HamburgerMenu";
import { GroupNav } from "../../components/GroupNav";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { getBridgeUrl } from "../../lib/bridge-api";

const TOP_BAR_HEIGHT = 48;

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

const TYPE_EMOJI: Record<string, string> = {
  purchase: "🛒",
  payment: "💸",
  withdrawal: "🏧",
  transfer_in: "📥",
  transfer_out: "📤",
  deposit: "💵",
};

function formatCOP(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("es-CO");
  return `$${formatted}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

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
            <Text style={{ color: "#525252", fontSize: 10, width: 28, fontFamily: "monospace" }}>
              {monthNames[monthIndex]}
            </Text>
            <View style={{ flex: 1, height: 18, backgroundColor: "#1A1A1A", borderRadius: 4, overflow: "hidden" }}>
              <View
                style={{
                  width: `${Math.max(ratio * 100, 2)}%`,
                  height: "100%",
                  backgroundColor: ratio > 0.8 ? "#EF4444" : ratio > 0.5 ? "#F59E0B" : "#06B6D4",
                  borderRadius: 4,
                }}
              />
            </View>
            <Text style={{ color: "#525252", fontSize: 10, width: 72, textAlign: "right", fontFamily: "monospace" }}>
              {formatCOP(expenses)}
            </Text>
          </View>
        );
      })}
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
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      {/* Top Bar */}
      <View style={{
        paddingTop: insets.top,
        height: TOP_BAR_HEIGHT + insets.top,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: hPad,
      }}>
        <Text style={{ color: "#F59E0B", fontSize: 22, fontWeight: "bold", letterSpacing: 2 }}>
          OZZU
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatusBadge />
          <HamburgerMenu />
        </View>
      </View>

      <View style={{ height: 1, backgroundColor: "#1A1A1A", marginHorizontal: hPad }} />

      <GroupNav group="me" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: hPad, paddingBottom: Math.max(24, insets.bottom), gap: 16 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#06B6D4" colors={["#06B6D4"]} />
        }
      >
        {/* Section header */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Text style={{ color: "#F59E0B", fontSize: 13, fontWeight: "700", letterSpacing: 1.5 }}>
            💰 FINANCE
          </Text>
        </View>

        {/* Monthly Summary Card */}
        <View style={{
          backgroundColor: "#111111",
          borderRadius: 14,
          padding: 16,
          borderWidth: 1,
          borderColor: "#1E1E1E",
        }}>
          <Text style={{ color: "#525252", fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 12 }}>
            MONTHLY SUMMARY
          </Text>

          {loadingSummary ? (
            <Text style={{ color: "#06B6D4", fontSize: 13, opacity: 0.6 }}>Loading...</Text>
          ) : errorSummary ? (
            <Text style={{ color: "#525252", fontSize: 12 }}>{errorSummary}</Text>
          ) : summary ? (
            <>
              {/* Current month big numbers */}
              <View style={{ flexDirection: "row", gap: 16, marginBottom: 16 }}>
                <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 10, padding: 12 }}>
                  <Text style={{ color: "#525252", fontSize: 10, fontWeight: "600", letterSpacing: 1, marginBottom: 4 }}>
                    EXPENSES
                  </Text>
                  <Text style={{ color: "#EF4444", fontSize: 22, fontWeight: "bold", fontFamily: "monospace" }} numberOfLines={1} adjustsFontSizeToFit>
                    {formatCOP(currentExpenses)}
                  </Text>
                </View>
                {currentIncome > 0 ? (
                  <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 10, padding: 12 }}>
                    <Text style={{ color: "#525252", fontSize: 10, fontWeight: "600", letterSpacing: 1, marginBottom: 4 }}>
                      INCOME
                    </Text>
                    <Text style={{ color: "#22C55E", fontSize: 22, fontWeight: "bold", fontFamily: "monospace" }} numberOfLines={1} adjustsFontSizeToFit>
                      {formatCOP(currentIncome)}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* Balance if known */}
              {balance !== null ? (
                <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                  <Text style={{ color: "#525252", fontSize: 10, fontWeight: "600", letterSpacing: 1, marginBottom: 4 }}>
                    LAST KNOWN BALANCE
                  </Text>
                  <Text style={{ color: "#F59E0B", fontSize: 18, fontWeight: "bold", fontFamily: "monospace" }}>
                    {formatCOP(balance)}
                  </Text>
                </View>
              ) : null}

              {/* 6-month bar chart */}
              <Text style={{ color: "#3A3A3A", fontSize: 10, fontWeight: "600", letterSpacing: 1, marginBottom: 4 }}>
                LAST 6 MONTHS — EXPENSES
              </Text>
              <BarChart months={summary.monthly || []} />
            </>
          ) : null}
        </View>

        {/* Recent Transactions */}
        <View style={{
          backgroundColor: "#111111",
          borderRadius: 14,
          padding: 16,
          borderWidth: 1,
          borderColor: "#1E1E1E",
        }}>
          <Text style={{ color: "#525252", fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 12 }}>
            RECENT TRANSACTIONS
          </Text>

          {loadingTx ? (
            <Text style={{ color: "#06B6D4", fontSize: 13, opacity: 0.6 }}>Loading...</Text>
          ) : errorTx ? (
            <Text style={{ color: "#525252", fontSize: 12 }}>{errorTx}</Text>
          ) : transactions.length === 0 ? (
            <Text style={{ color: "#525252", fontSize: 12 }}>No transactions</Text>
          ) : (
            <View style={{ gap: 2 }}>
              {transactions.map((tx, i) => {
                const isPositive = tx.amount > 0;
                const emoji = TYPE_EMOJI[tx.type] || "💳";
                return (
                  <View
                    key={tx.id || i}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 10,
                      borderBottomWidth: i < transactions.length - 1 ? 1 : 0,
                      borderBottomColor: "#1A1A1A",
                    }}
                  >
                    {/* Left: emoji */}
                    <Text style={{ fontSize: 18, width: 28 }}>{emoji}</Text>

                    {/* Center: merchant + date */}
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text
                        style={{ color: "#E5E5E5", fontSize: 13, fontWeight: "600" }}
                        numberOfLines={1}
                      >
                        {tx.merchant || "Unknown"}
                      </Text>
                      <Text style={{ color: "#525252", fontSize: 11, marginTop: 1 }}>
                        {tx.date ? formatDate(tx.date) : ""}
                      </Text>
                    </View>

                    {/* Right: amount */}
                    <Text style={{
                      color: isPositive ? "#22C55E" : "#EF4444",
                      fontSize: 13,
                      fontWeight: "700",
                      fontFamily: "monospace",
                      marginLeft: 8,
                    }}>
                      {isPositive ? "+" : "-"}{formatCOP(tx.amount)}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
