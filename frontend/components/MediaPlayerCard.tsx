import { Text, View } from "react-native";
import { TVPressable } from "./TVPressable";
import { useEntity } from "../lib/useEntity";
import { useHA } from "../lib/ha-context";

interface MediaPlayerCardProps {
  entityId: string;
}

export function MediaPlayerCard({ entityId }: MediaPlayerCardProps) {
  const entity = useEntity(entityId);
  const { callService } = useHA();
  const name =
    entity?.attributes.friendly_name ?? entityId.split(".").pop() ?? entityId;
  const state = entity?.state ?? "unavailable";
  const isPlaying = state === "playing";

  const togglePlayPause = () => {
    callService("media_player", "media_play_pause", undefined, {
      entity_id: entityId,
    });
  };

  return (
    <TVPressable
      onPress={togglePlayPause}
      className={`min-w-[160px] min-h-[120px] rounded-2xl border-2 p-4 justify-between ${
        isPlaying
          ? "bg-purple-900/50 border-purple-500"
          : "bg-neutral-800 border-neutral-700"
      }`}
    >
      <Text className="text-lg text-neutral-300" numberOfLines={2}>
        {name}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text className="text-2xl font-bold text-white">{state}</Text>
        <Text className="text-lg text-neutral-400">
          {isPlaying ? "⏸" : "▶"}
        </Text>
      </View>
    </TVPressable>
  );
}
