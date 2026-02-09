import { ScrollView, View, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { RoomSection } from "../components/RoomSection";
import { rooms } from "../lib/rooms";

export default function DashboardScreen() {
  return (
    <View className="flex-1 bg-[#111111]">
      <View className="flex-row items-center justify-between px-6 pt-4 pb-2">
        <Text className="text-3xl font-bold text-white">ozzu</Text>
        <StatusBadge />
      </View>
      <ScrollView className="flex-1" contentContainerClassName="pb-8 pt-2">
        {rooms.map((room, index) => (
          <RoomSection key={room.name} room={room} isFirst={index === 0} />
        ))}
      </ScrollView>
      <StatusBar style="light" />
    </View>
  );
}
