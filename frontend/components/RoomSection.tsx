import { Text, ScrollView, View } from "react-native";
import { EntityCard } from "./EntityCard";
import type { Room } from "../lib/rooms";

interface RoomSectionProps {
  room: Room;
  isFirst?: boolean;
}

export function RoomSection({ room, isFirst }: RoomSectionProps) {
  return (
    <View className="mb-6">
      <Text className="text-3xl font-bold text-white mb-3 px-6">
        {room.name}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-6 gap-4"
      >
        {room.entities.map((entityId, index) => (
          <EntityCard key={entityId} entityId={entityId} />
        ))}
      </ScrollView>
    </View>
  );
}
