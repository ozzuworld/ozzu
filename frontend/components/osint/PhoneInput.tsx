import { View, Text, TextInput } from "react-native";
import { useState, useCallback } from "react";

interface Props {
  value: string;
  onChangeText: (text: string) => void;
}

// Normalize to E.164 format as user types
function formatPhone(input: string): string {
  // Strip non-digit chars except leading +
  const hasPlus = input.startsWith("+");
  const digits = input.replace(/\D/g, "");
  if (!digits) return hasPlus ? "+" : "";
  return (hasPlus ? "+" : "") + digits;
}

function validateE164(phone: string): boolean {
  // E.164: + followed by 7-15 digits
  return /^\+\d{7,15}$/.test(phone);
}

export function PhoneInput({ value, onChangeText }: Props) {
  const [touched, setTouched] = useState(false);
  const isValid = !touched || !value || validateE164(value);

  const handleChange = useCallback((text: string) => {
    setTouched(true);
    onChangeText(formatPhone(text));
  }, [onChangeText]);

  return (
    <View style={{ gap: 4 }}>
      <TextInput
        value={value}
        onChangeText={handleChange}
        placeholder="+1234567890"
        placeholderTextColor="#3B3B3B"
        keyboardType="phone-pad"
        autoCapitalize="none"
        style={{
          backgroundColor: "#0A0A0A",
          borderWidth: 1,
          borderColor: isValid ? "#333" : "#EF4444",
          borderRadius: 6,
          padding: 10,
          color: "#E5E5E5",
          fontSize: 14,
          fontFamily: "monospace",
        }}
      />
      <Text style={{ color: isValid ? "#525252" : "#EF4444", fontSize: 9, fontFamily: "monospace" }}>
        {isValid ? "E.164 format: +[country code][number]" : "Invalid format. Use +[country code][number] (7-15 digits)"}
      </Text>
    </View>
  );
}
