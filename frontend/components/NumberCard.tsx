import { Text, View } from "react-native";
import { TVPressable } from "./TVPressable";
import { useEntity } from "../lib/useEntity";
import { useHA } from "../lib/ha-context";

interface NumberCardProps {
  entityId: string;
}

export function NumberCard({ entityId }: NumberCardProps) {
  const entity = useEntity(entityId);
  const { callService } = useHA();
  const name =
    entity?.attributes.friendly_name ?? entityId.split(".").pop() ?? entityId;
  const value = Number(entity?.state ?? 0);
  const unit = entity?.attributes.unit_of_measurement ?? "";
  const step = entity?.attributes.step ?? 1;
  const min = entity?.attributes.min ?? 0;
  const max = entity?.attributes.max ?? 100;

  const setValue = (newValue: number) => {
    const clamped = Math.min(max, Math.max(min, newValue));
    callService("number", "set_value", { value: clamped }, {
      entity_id: entityId,
    });
  };

  return (
    <View className="min-w-[160px] min-h-[120px] rounded-2xl border-2 border-neutral-700 bg-neutral-800 p-4 justify-between">
      <Text className="text-lg text-neutral-300" numberOfLines={2}>
        {name}
      </Text>
      <View className="flex-row items-center gap-3">
        <TVPressable
          onPress={() => setValue(value - step)}
          className="w-10 h-10 rounded-lg bg-neutral-700 border-2 border-neutral-600 items-center justify-center"
        >
          <Text className="text-xl font-bold text-white">−</Text>
        </TVPressable>
        <Text className="text-2xl font-bold text-white">
          {value}{unit ? ` ${unit}` : ""}
        </Text>
        <TVPressable
          onPress={() => setValue(value + step)}
          className="w-10 h-10 rounded-lg bg-neutral-700 border-2 border-neutral-600 items-center justify-center"
        >
          <Text className="text-xl font-bold text-white">+</Text>
        </TVPressable>
      </View>
    </View>
  );
}
