import { View, Text } from "react-native";
import { useHA } from "../lib/ha-context";

const statusColors: Record<string, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-500",
  disconnected: "bg-neutral-500",
  error: "bg-red-500",
};

export function StatusBadge() {
  const { status } = useHA();

  return (
    <View className="flex-row items-center gap-2">
      <View className={`w-3 h-3 rounded-full ${statusColors[status]}`} />
      <Text className="text-neutral-400 text-sm">{status}</Text>
    </View>
  );
}
