import { Text, View } from "react-native";
import { useEntity } from "../lib/useEntity";

interface SensorCardProps {
  entityId: string;
}

export function SensorCard({ entityId }: SensorCardProps) {
  const entity = useEntity(entityId);
  const name =
    entity?.attributes.friendly_name ?? entityId.split(".").pop() ?? entityId;
  const unit = entity?.attributes.unit_of_measurement ?? "";
  const value = entity?.state ?? "—";

  return (
    <View className="min-w-[160px] min-h-[120px] rounded-2xl border-2 border-neutral-700 bg-neutral-800 p-4 justify-between">
      <Text className="text-lg text-neutral-300" numberOfLines={2}>
        {name}
      </Text>
      <Text className="text-2xl font-bold text-white">
        {value}
        {unit ? ` ${unit}` : ""}
      </Text>
    </View>
  );
}
