import { Text, View } from "react-native";
import { TVPressable } from "./TVPressable";
import { useEntity } from "../lib/useEntity";
import { useHA } from "../lib/ha-context";

interface SwitchCardProps {
  entityId: string;
}

export function SwitchCard({ entityId }: SwitchCardProps) {
  const entity = useEntity(entityId);
  const { callService } = useHA();
  const isOn = entity?.state === "on";
  const name =
    entity?.attributes.friendly_name ?? entityId.split(".").pop() ?? entityId;

  const toggle = () => {
    const domain = entityId.split(".")[0];
    callService(domain, "toggle", undefined, { entity_id: entityId });
  };

  return (
    <TVPressable
      onPress={toggle}
      className={`min-w-[160px] min-h-[120px] rounded-2xl border-2 p-4 justify-between ${
        isOn
          ? "bg-blue-900/50 border-blue-500"
          : "bg-neutral-800 border-neutral-700"
      }`}
    >
      <Text className="text-lg text-neutral-300" numberOfLines={2}>
        {name}
      </Text>
      <Text className={`text-2xl font-bold ${isOn ? "text-blue-400" : "text-neutral-500"}`}>
        {isOn ? "ON" : "OFF"}
      </Text>
    </TVPressable>
  );
}
