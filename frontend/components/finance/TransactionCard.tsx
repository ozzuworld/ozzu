import { View, Text, Pressable } from "react-native";
import { colors } from "../../lib/design-tokens";
import { formatCOP, formatShortDate } from "../../lib/format";

export type Transaction = {
  id?: string | number;
  type: string;
  merchant?: string | null;
  date?: string | null;
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

const TYPE_COLOR: Record<string, string> = {
  purchase: colors.brand.amber,
  payment: colors.accent,
  withdrawal: colors.error,
  transfer_in: colors.success,
  transfer_out: colors.brand.amberDeep,
  deposit: colors.success,
};

const TYPE_LABEL: Record<string, string> = {
  purchase: "PURCHASE",
  payment: "PAYMENT",
  withdrawal: "WITHDRAW",
  transfer_in: "TRANSFER IN",
  transfer_out: "TRANSFER OUT",
  deposit: "DEPOSIT",
};

interface TransactionCardProps {
  tx: Transaction;
  onPress?: () => void;
}

export function TransactionCard({ tx, onPress }: TransactionCardProps) {
  const accentColor = TYPE_COLOR[tx.type] || colors.accent;
  const emoji = TYPE_EMOJI[tx.type] || "💳";
  const label = TYPE_LABEL[tx.type] || tx.type.toUpperCase();
  const isPositive = tx.amount > 0;
  const amountColor = isPositive ? colors.success : colors.error;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        opacity: pressed && onPress ? 0.92 : 1,
        transform: [{ scale: pressed && onPress ? 0.98 : 1 }],
      })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: 12,
          borderLeftWidth: 3,
          borderLeftColor: accentColor,
          marginBottom: 10,
          padding: 14,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.04)",
        }}
      >
        {/* Header row: emoji + merchant + amount */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontSize: 20 }}>{emoji}</Text>
          <Text
            style={{ color: colors.gray[50], fontSize: 15, fontWeight: "600", flex: 1 }}
            numberOfLines={1}
          >
            {tx.merchant || "Unknown"}
          </Text>
          <Text
            style={{
              color: amountColor,
              fontSize: 14,
              fontWeight: "700",
              fontFamily: "monospace",
            }}
          >
            {isPositive ? "+" : "-"}{formatCOP(tx.amount)}
          </Text>
        </View>

        {/* Metadata row: type pill + date */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
          <View
            style={{
              backgroundColor: accentColor + "22",
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 4,
            }}
          >
            <Text style={{ color: accentColor, fontSize: 9, fontFamily: "monospace", fontWeight: "700", letterSpacing: 0.5 }}>
              {label}
            </Text>
          </View>
          {tx.date ? (
            <Text style={{ color: colors.gray[400], fontSize: 11, fontFamily: "monospace" }}>
              {formatShortDate(tx.date)}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
