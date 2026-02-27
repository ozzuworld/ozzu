import { useState, useRef, useCallback } from "react";
import { View, Text, Pressable, PanResponder, LayoutChangeEvent } from "react-native";
import { useEntity } from "../../lib/useEntity";
import { useHA } from "../../lib/ha-context";

interface ACWidgetProps {
  entityId: string;
}

const TEMP_MIN = 61;
const TEMP_MAX = 86;
const ACCENT = "#06B6D4";

const HVAC_MODES = [
  { key: "cool", label: "COOL", emoji: "❄️" },
  { key: "heat", label: "HEAT", emoji: "🔥" },
  { key: "auto", label: "AUTO", emoji: "🔄" },
  { key: "dry", label: "DRY", emoji: "💧" },
  { key: "fan_only", label: "FAN", emoji: "💨" },
  { key: "off", label: "OFF", emoji: "⭕" },
];

const FAN_MODES = [
  { key: "auto", label: "AUTO" },
  { key: "low", label: "LOW" },
  { key: "medium", label: "MED" },
  { key: "high", label: "HIGH" },
];

export function ACWidget({ entityId }: ACWidgetProps) {
  const entity = useEntity(entityId);
  const { callService } = useHA();
  const [sliderWidth, setSliderWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragTemp, setDragTemp] = useState<number | null>(null);
  const sliderRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attrs = entity?.attributes ?? {};
  const currentTemp = (attrs.current_temperature as number) ?? null;
  const targetTemp = dragTemp ?? (attrs.temperature as number) ?? 72;
  const hvacMode = (attrs.hvac_mode as string) ?? (entity?.state as string) ?? "off";
  const fanMode = (attrs.fan_mode as string) ?? "auto";
  const isOff = entity?.state === "off";

  const tempToX = (temp: number) => {
    const pct = (temp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN);
    return pct * sliderWidth;
  };

  const xToTemp = (x: number) => {
    const pct = Math.max(0, Math.min(1, x / sliderWidth));
    return Math.round(TEMP_MIN + pct * (TEMP_MAX - TEMP_MIN));
  };

  const setTemperature = useCallback(
    (temp: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        callService("climate", "set_temperature", { temperature: temp }, { entity_id: entityId });
      }, 300);
    },
    [callService, entityId]
  );

  const setHvacMode = useCallback(
    (mode: string) => {
      callService("climate", "set_hvac_mode", { hvac_mode: mode }, { entity_id: entityId });
    },
    [callService, entityId]
  );

  const setFanMode = useCallback(
    (mode: string) => {
      callService("climate", "set_fan_mode", { fan_mode: mode }, { entity_id: entityId });
    },
    [callService, entityId]
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_, gs) => {
        setDragging(true);
        const x = gs.x0 - sliderRef.current;
        const temp = xToTemp(x);
        setDragTemp(temp);
      },
      onPanResponderMove: (_, gs) => {
        const x = gs.x0 + gs.dx - sliderRef.current;
        const temp = xToTemp(x);
        setDragTemp(temp);
      },
      onPanResponderRelease: () => {
        setDragging(false);
        if (dragTemp !== null) {
          setTemperature(dragTemp);
        }
        setDragTemp(null);
      },
    })
  ).current;

  const onSliderLayout = (e: LayoutChangeEvent) => {
    setSliderWidth(e.nativeEvent.layout.width);
    sliderRef.current = e.nativeEvent.layout.x;
  };

  if (!entity) return null;

  const modeColor = isOff ? "#525252" : hvacMode === "cool" ? "#3B82F6" : hvacMode === "heat" ? "#EF4444" : ACCENT;

  return (
    <View style={{ marginTop: 8 }}>
      {/* Header: AC icon + current temp */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={{ fontSize: 16 }}>❄️</Text>
        <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>
          AC
        </Text>
        {currentTemp !== null && (
          <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 12 }}>
            · {Math.round(currentTemp)}°F
          </Text>
        )}
        <Text style={{ color: modeColor, fontFamily: "monospace", fontSize: 11, marginLeft: "auto" }}>
          {hvacMode.toUpperCase()} → {Math.round(targetTemp)}°F
        </Text>
      </View>

      {/* Temp slider */}
      <View
        style={{
          height: 32,
          justifyContent: "center",
          paddingHorizontal: 4,
        }}
        onLayout={(e) => {
          sliderRef.current = e.nativeEvent.layout.x;
          setSliderWidth(e.nativeEvent.layout.width - 8);
        }}
        {...panResponder.panHandlers}
      >
        {/* Track */}
        <View
          style={{
            height: 4,
            backgroundColor: "#333",
            borderRadius: 2,
          }}
          onLayout={onSliderLayout}
        >
          {/* Fill */}
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: sliderWidth > 0 ? tempToX(targetTemp) : 0,
              backgroundColor: modeColor,
              borderRadius: 2,
            }}
          />
        </View>
        {/* Thumb */}
        {sliderWidth > 0 && (
          <View
            style={{
              position: "absolute",
              left: tempToX(targetTemp) - 8 + 4,
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: dragging ? "#FFF" : modeColor,
              borderWidth: 2,
              borderColor: "#111",
            }}
          />
        )}
        {/* Min/max labels */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>{TEMP_MIN}°</Text>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>{TEMP_MAX}°</Text>
        </View>
      </View>

      {/* HVAC mode pills */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {HVAC_MODES.map((m) => {
          const active = hvacMode === m.key;
          return (
            <Pressable
              key={m.key}
              onPress={() => setHvacMode(m.key)}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: active ? ACCENT : "#333",
                backgroundColor: active ? "rgba(6,182,212,0.15)" : "transparent",
              }}
            >
              <Text
                style={{
                  color: active ? ACCENT : "#737373",
                  fontFamily: "monospace",
                  fontSize: 10,
                  fontWeight: "bold",
                }}
              >
                {m.emoji} {m.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Fan speed pills */}
      {!isOff && (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, alignSelf: "center" }}>
            FAN:
          </Text>
          {FAN_MODES.map((f) => {
            const active = fanMode === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setFanMode(f.key)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: active ? ACCENT : "#333",
                  backgroundColor: active ? "rgba(6,182,212,0.15)" : "transparent",
                }}
              >
                <Text
                  style={{
                    color: active ? ACCENT : "#737373",
                    fontFamily: "monospace",
                    fontSize: 10,
                    fontWeight: "bold",
                  }}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
