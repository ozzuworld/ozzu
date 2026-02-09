import { View, Text, Platform, type ViewStyle } from "react-native";

const glowStyle: ViewStyle = Platform.OS === "web"
  ? { // @ts-ignore – web-only boxShadow
      boxShadow: "0 0 20px #333",
    }
  : {
      shadowColor: "#333",
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.6,
      shadowRadius: 20,
    };

export function CharacterSilhouette() {
  return (
    <View style={{ alignItems: "center", justifyContent: "center" }}>
      {/* Character Figure */}
      <View style={[{ alignItems: "center" }, glowStyle]}>
        {/* Head */}
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: "#2A2A2A",
            borderWidth: 2,
            borderColor: "#444",
          }}
        />
        {/* Neck */}
        <View
          style={{
            width: 4,
            height: 8,
            backgroundColor: "#444",
          }}
        />
        {/* Torso + Arms */}
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          {/* Left Arm */}
          <View
            style={{
              width: 4,
              height: 50,
              backgroundColor: "#444",
              borderRadius: 2,
              transform: [{ rotate: "15deg" }],
              marginTop: 4,
            }}
          />
          {/* Torso */}
          <View
            style={{
              width: 44,
              height: 60,
              backgroundColor: "#2A2A2A",
              borderWidth: 2,
              borderColor: "#444",
              borderRadius: 6,
              marginHorizontal: 4,
            }}
          />
          {/* Right Arm */}
          <View
            style={{
              width: 4,
              height: 50,
              backgroundColor: "#444",
              borderRadius: 2,
              transform: [{ rotate: "-15deg" }],
              marginTop: 4,
            }}
          />
        </View>
        {/* Legs */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 2 }}>
          <View
            style={{
              width: 4,
              height: 55,
              backgroundColor: "#444",
              borderRadius: 2,
              transform: [{ rotate: "5deg" }],
            }}
          />
          <View
            style={{
              width: 4,
              height: 55,
              backgroundColor: "#444",
              borderRadius: 2,
              transform: [{ rotate: "-5deg" }],
            }}
          />
        </View>
      </View>

      {/* Flavor Text */}
      <View style={{ alignItems: "center", marginTop: 16 }}>
        <Text
          style={{
            color: "#555",
            fontSize: 11,
            fontWeight: "bold",
            letterSpacing: 2,
          }}
        >
          LVL 1
        </Text>
        <Text
          style={{
            color: "#444",
            fontSize: 13,
            fontWeight: "bold",
            letterSpacing: 3,
            marginTop: 2,
          }}
        >
          HOMEKEEPER
        </Text>
      </View>
    </View>
  );
}
