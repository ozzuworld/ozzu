import { useState, useCallback, useEffect } from "react";
import { View, Text, Modal, Pressable } from "react-native";

import { colors } from "../lib/design-tokens";
interface KeypadProps {
  visible: boolean;
  title?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

const KEYS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["⌫", "0", "✓"],
] as const;

export function Keypad({ visible, title, onSubmit, onCancel }: KeypadProps) {
  const [pin, setPin] = useState("");

  // Clear PIN whenever keypad becomes visible (fresh start each time)
  useEffect(() => {
    if (visible) setPin("");
  }, [visible]);

  const handleKey = useCallback(
    (key: string) => {
      if (key === "⌫") {
        setPin((p) => p.slice(0, -1));
      } else if (key === "✓") {
        if (pin.length > 0) {
          onSubmit(pin);
          setPin("");
        }
      } else if (pin.length < 8) {
        setPin((p) => p + key);
      }
    },
    [pin, onSubmit]
  );

  const handleCancel = useCallback(() => {
    setPin("");
    onCancel();
  }, [onCancel]);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.85)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            backgroundColor: colors.gray[800],
            borderWidth: 2,
            borderColor: colors.accent,
            borderRadius: 16,
            padding: 24,
            width: 280,
            shadowColor: colors.accent,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: 0.3,
            shadowRadius: 20,
            elevation: 10,
          }}
        >
          {/* Title */}
          <Text
            style={{
              color: colors.accent,
              fontSize: 14,
              fontWeight: "bold",
              letterSpacing: 2,
              textAlign: "center",
              marginBottom: 8,
            }}
          >
            {title || "ENTER PIN"}
          </Text>

          {/* PIN display */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              gap: 8,
              marginBottom: 20,
              height: 40,
              alignItems: "center",
            }}
          >
            {pin.length === 0 ? (
              <Text style={{ color: colors.gray[400], fontSize: 16, fontFamily: "monospace" }}>
                ····
              </Text>
            ) : (
              pin.split("").map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: colors.accent,
                  }}
                />
              ))
            )}
          </View>

          {/* Key grid */}
          {KEYS.map((row, ri) => (
            <View
              key={ri}
              style={{
                flexDirection: "row",
                justifyContent: "center",
                gap: 12,
                marginBottom: 12,
              }}
            >
              {row.map((key) => {
                const isAction = key === "⌫" || key === "✓";
                const isConfirm = key === "✓";
                return (
                  <Pressable
                    key={key}
                    onPress={() => handleKey(key)}
                    style={({ pressed }) => ({
                      width: 64,
                      height: 52,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: isConfirm
                        ? colors.success
                        : isAction
                        ? colors.brand.amber
                        : colors.gray[600],
                      backgroundColor: pressed
                        ? isConfirm
                          ? "rgba(34,197,94,0.2)"
                          : "rgba(6,182,212,0.15)"
                        : "#222",
                      alignItems: "center",
                      justifyContent: "center",
                    })}
                  >
                    <Text
                      style={{
                        color: isConfirm ? colors.success : isAction ? colors.brand.amber : "#E0E0E0",
                        fontSize: isAction ? 20 : 22,
                        fontWeight: "bold",
                        fontFamily: isAction ? undefined : "monospace",
                      }}
                    >
                      {key}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}

          {/* Cancel */}
          <Pressable
            onPress={handleCancel}
            style={{
              marginTop: 4,
              alignSelf: "center",
              paddingVertical: 8,
              paddingHorizontal: 24,
            }}
          >
            <Text
              style={{
                color: colors.error,
                fontSize: 13,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              CANCEL
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
