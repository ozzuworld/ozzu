import { View, Text, Pressable } from "react-native";
import { formatCurrency, type BusinessInvestment } from "../../lib/bridge-api";

const STATUS_COLORS: Record<string, string> = {
  planned: "#737373",
  committed: "#F59E0B",
  paid: "#3B82F6",
  recovered: "#22C55E",
};

const CATEGORY_EMOJIS: Record<string, string> = {
  equipment: "🔧",
  infrastructure: "🏗️",
  inventory: "📦",
  marketing: "📣",
  certification: "📜",
  logistics: "🚚",
  other: "💰",
};

interface Props {
  investment: BusinessInvestment;
  onPress?: () => void;
}

export function InvestmentCard({ investment, onPress }: Props) {
  const statusColor = STATUS_COLORS[investment.status] || "#737373";
  const emoji = CATEGORY_EMOJIS[investment.category] || "💰";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "#222" : "#1A1A1A",
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
          <Text style={{ fontSize: 16 }}>{emoji}</Text>
          <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 13, fontWeight: "bold", flex: 1 }} numberOfLines={1}>
            {investment.title}
          </Text>
        </View>
        <Text style={{ color: statusColor, fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>
          {formatCurrency(investment.amount, investment.currency)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginLeft: 28 }}>
        <View style={{ backgroundColor: statusColor + "22", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
          <Text style={{ color: statusColor, fontFamily: "monospace", fontSize: 9, fontWeight: "bold", textTransform: "uppercase" }}>
            {investment.status}
          </Text>
        </View>
        <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, textTransform: "uppercase" }}>{investment.category}</Text>
      </View>
      {investment.roi_notes && (
        <Text style={{ color: "#404040", fontFamily: "monospace", fontSize: 10, marginTop: 6, marginLeft: 28 }} numberOfLines={1}>{investment.roi_notes}</Text>
      )}
    </Pressable>
  );
}
