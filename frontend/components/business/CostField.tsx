import { useState } from "react";
import { View, Text, TextInput } from "react-native";

function formatCOPDisplay(amount: number): string {
  if (!amount && amount !== 0) return "";
  return "$" + Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatCOPCompact(amount: number): string {
  if (!amount) return "$0";
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return formatCOPDisplay(amount);
}

interface CostFieldProps {
  value: number | null;
  onChange: (val: number | null) => void;
  label?: string;
  placeholder?: string;
  editable?: boolean;
}

export function CostField({ value, onChange, label, placeholder = "$0", editable = true }: CostFieldProps) {
  const [text, setText] = useState(value ? String(value) : "");

  const handleChange = (input: string) => {
    const cleaned = input.replace(/[^0-9]/g, "");
    setText(cleaned);
    onChange(cleaned ? parseInt(cleaned, 10) : null);
  };

  return (
    <View>
      {label ? (
        <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>{label}</Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#111", borderRadius: 8, borderWidth: 1, borderColor: "#2A2A2A" }}>
        <Text style={{ color: "#525252", fontSize: 14, paddingLeft: 12 }}>$</Text>
        <TextInput
          value={text}
          onChangeText={handleChange}
          placeholder={placeholder}
          placeholderTextColor="#525252"
          keyboardType="numeric"
          editable={editable}
          style={{ flex: 1, color: "#E5E5E5", padding: 10, fontSize: 14 }}
        />
        {text ? (
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, paddingRight: 12 }}>
            {formatCOPDisplay(parseInt(text, 10) || 0)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export { formatCOPDisplay, formatCOPCompact };
