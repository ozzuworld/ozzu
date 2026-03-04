import { View, Text, Pressable } from "react-native";
import type { BusinessExpense } from "../../lib/bridge-api";
import { formatCOPDisplay } from "./CostField";

const CATEGORY_ICONS: Record<string, string> = {
  materials: "M",
  labor: "L",
  services: "S",
  equipment: "E",
  transport: "T",
  permits: "P",
  fees: "F",
  other: "O",
};

const PAYMENT_STATUS_COLOR: Record<string, string> = {
  pending: "#EAB308",
  paid: "#22C55E",
  partial: "#F97316",
  overdue: "#EF4444",
};

interface ExpenseRowProps {
  expense: BusinessExpense;
  onPress: () => void;
  onDelete: () => void;
}

export function ExpenseRow({ expense, onPress, onDelete }: ExpenseRowProps) {
  const statusColor = PAYMENT_STATUS_COLOR[expense.payment_status] || "#525252";
  const catIcon = CATEGORY_ICONS[expense.category] || "?";

  return (
    <Pressable onPress={onPress} onLongPress={onDelete}>
      <View style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 8,
        padding: 12,
        marginBottom: 6,
        flexDirection: "row",
        alignItems: "center",
      }}>
        {/* Category icon */}
        <View style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          backgroundColor: "#2A2A2A",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
        }}>
          <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
            {catIcon}
          </Text>
        </View>

        {/* Info */}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: "#E5E5E5", fontSize: 13, fontWeight: "bold" }} numberOfLines={1}>
              {formatCOPDisplay(expense.amount)}
            </Text>
            {expense.iva_amount > 0 ? (
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>
                IVA {formatCOPDisplay(expense.iva_amount)}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {expense.vendor ? (
              <Text style={{ color: "#737373", fontSize: 11 }} numberOfLines={1}>{expense.vendor}</Text>
            ) : null}
            <Text style={{ color: "#525252", fontSize: 10 }}>
              {new Date(expense.expense_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </Text>
          </View>
        </View>

        {/* Verified badge + status badge */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{
            backgroundColor: expense.verified ? "#22C55E22" : "#EAB30822",
            paddingHorizontal: 5,
            paddingVertical: 2,
            borderRadius: 4,
          }}>
            <Text style={{
              color: expense.verified ? "#22C55E" : "#EAB308",
              fontFamily: "monospace",
              fontSize: 7,
              fontWeight: "bold",
            }}>
              {expense.verified ? "VERIFIED" : "UNVERIFIED"}
            </Text>
          </View>
          <View style={{ backgroundColor: statusColor + "22", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
            <Text style={{ color: statusColor, fontFamily: "monospace", fontSize: 8, fontWeight: "bold" }}>
              {expense.payment_status.toUpperCase()}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}
