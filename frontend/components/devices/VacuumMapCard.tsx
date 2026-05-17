import { Image, Pressable, Text, View } from "react-native";
import { useVacuum } from "../../lib/useVacuum";

export function VacuumMapCard() {
  const { state } = useVacuum();

  if (!state.mapUrl) return null;

  return (
    <Pressable
      style={({ pressed }) => ({
        marginTop: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#2A2A2A",
        backgroundColor: "#1A1A1A",
        overflow: "hidden",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Image
        source={{ uri: state.mapUrl }}
        style={{ width: "100%", height: 160, backgroundColor: "#0A0A0A" }}
        resizeMode="contain"
      />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 10,
          paddingVertical: 6,
        }}
      >
        <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
          MAP
        </Text>
        <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10 }}>
          Tap to open
        </Text>
      </View>
    </Pressable>
  );
}
