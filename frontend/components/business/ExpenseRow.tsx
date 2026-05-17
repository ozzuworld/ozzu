import { View, Text, Pressable } from "react-native";
import type { BusinessExpense } from "../../lib/bridge-api";
import { formatCOPDisplay } from "./CostField";

import { colors } from "../../lib/design-tokens";
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
  pending: colors.brand.amberDeep,
  paid: colors.success,
  partial: colors.brand.orange,
  overdue: colors.error,
};

interface ExpenseRowProps {
  expense: BusinessExpense;
  onPress: () => void;
  onDelete: () => void;
}

export function ExpenseRow({ expense, onPress, onDelete }: ExpenseRowProps) {
  const statusColor = PAYMENT_STATUS_COLOR[expense.payment_status] || colors.gray[400];
  const catIcon = CATEGORY_ICONS[expense.category] || "?";

  return (
    <Pressable onPress={onPress} onLongPress={onDelete}>
      <View style={{
        backgroundColor: colors.gray[800],
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
          backgroundColor: colors.gray[700],
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
        }}>
          <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
            {catIcon}
          </Text>
        </View>

        {/* Info */}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: colors.gray[50], fontSize: 13, fontWeight: "bold" }} numberOfLines={1}>
              {formatCOPDisplay(expense.amount)}
            </Text>
            {expense.iva_amount > 0 ? (
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>
                IVA {formatCOPDisplay(expense.iva_amount)}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {expense.vendor ? (
              <Text style={{ color: colors.gray[300], fontSize: 11 }} numberOfLines={1}>{expense.vendor}</Text>
            ) : null}
            <Text style={{ color: colors.gray[400], fontSize: 10 }}>
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
              color: expense.verified ? colors.success : colors.brand.amberDeep,
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
