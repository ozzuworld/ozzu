import { Modal, Pressable, View, Text } from "react-native";
import type { MapPin } from "../../lib/map-config";
import { useEntity } from "../../lib/useEntity";
import { useHA } from "../../lib/ha-context";
import { ACSheet } from "./sheets/ACSheet";
import { CameraSheet } from "./sheets/CameraSheet";
import { VacuumSheet } from "./sheets/VacuumSheet";
import { MediaSheet } from "./sheets/MediaSheet";

interface DeviceSheetProps {
  visible: boolean;
  pin: MapPin | null;
  onDismiss: () => void;
}

function GenericSheet({ pin }: { pin: MapPin }) {
  const entity = useEntity(pin.primaryEntityId);
  const { callService } = useHA();
  const isOn = entity?.state === "on";

  const handleToggle = () => {
    const domain = pin.primaryEntityId.split(".")[0];
    callService(domain, "toggle", {}, { entity_id: pin.primaryEntityId });
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 12 }}>
          {entity?.state ?? "unavailable"}
        </Text>
        <Pressable
          onPress={handleToggle}
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: isOn ? "rgba(34,197,94,0.2)" : "rgba(82,82,82,0.2)",
            borderWidth: 1,
            borderColor: isOn ? "#22C55E" : "#525252",
          }}
        >
          <Text style={{ color: isOn ? "#22C55E" : "#525252", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
            {isOn ? "ON" : "OFF"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function SheetContent({ pin }: { pin: MapPin }) {
  switch (pin.type) {
    case "ac":
      return <ACSheet entityId={pin.primaryEntityId} />;
    case "camera":
      return <CameraSheet pin={pin} />;
    case "vacuum":
      return <VacuumSheet />;
    case "media":
      return <MediaSheet pin={pin} />;
    default:
      return <GenericSheet pin={pin} />;
  }
}

export function DeviceSheet({ visible, pin, onDismiss }: DeviceSheetProps) {
  if (!pin) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        onPress={onDismiss}
        style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
      >
        <Pressable onPress={(e) => e.stopPropagation()}>
          <View
            style={{
              backgroundColor: "#1A1A1A",
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingHorizontal: 20,
              paddingBottom: 32,
              maxHeight: "55%",
            }}
          >
            {/* Drag handle */}
            <View style={{ alignItems: "center", paddingVertical: 10 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#525252" }} />
            </View>

            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <Text style={{ fontSize: 22 }}>{pin.icon}</Text>
              <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", flex: 1 }}>
                {pin.label}
              </Text>
            </View>

            {/* Type-specific content */}
            <SheetContent pin={pin} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
