import { View, Text } from "react-native";
import { TVPressable } from "../TVPressable";

export type ToolbarItem = {
  id: string;
  icon: string;
  color: string;
  active: boolean;
  onPress: () => void;
};

type Props = {
  items: ToolbarItem[];
  bottomInset?: number;
};

export default function ToolbarPill({ items, bottomInset = 0 }: Props) {
  return (
    <View
      style={{
        position: "absolute",
        bottom: Math.max(16, bottomInset + 8),
        alignSelf: "center",
        flexDirection: "row",
        backgroundColor: "rgba(0,0,0,0.7)",
        borderRadius: 24,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 4,
      }}
    >
      {items.map((item) => (
        <TVPressable
          key={item.id}
          onPress={item.onPress}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: item.active
              ? `${item.color}25`
              : "transparent",
          }}
        >
          <Text
            style={{
              fontSize: 20,
              opacity: item.active ? 1 : 0.5,
            }}
          >
            {item.icon}
          </Text>
        </TVPressable>
      ))}
    </View>
  );
}
