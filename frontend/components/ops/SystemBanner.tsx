import { View, Text } from "react-native";
import type { ServiceStatus } from "../../lib/ops-hooks";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;

interface Props {
  services: Record<string, ServiceStatus>;
}

export default function SystemBanner({ services }: Props) {
  const entries = Object.entries(services);
  const downServices = entries.filter(([, s]) => s.status === "down");
  const degradedServices = entries.filter(([, s]) => s.status === "degraded");
  const allHealthy = downServices.length === 0 && degradedServices.length === 0;

  const bgColor = allHealthy
    ? "rgba(34, 197, 94, 0.12)"
    : downServices.length > 0
    ? "rgba(239, 68, 68, 0.15)"
    : "rgba(234, 179, 8, 0.12)";

  const borderColor = allHealthy ? colors.success : downServices.length > 0 ? colors.error : colors.brand.amberDeep;
  const textColor = allHealthy ? colors.success : downServices.length > 0 ? colors.error : colors.brand.amberDeep;

  let label: string;
  if (allHealthy) {
    label = "ALL SYSTEMS OPERATIONAL";
  } else if (downServices.length > 0) {
    const names = downServices.map(([n]) => n.toUpperCase()).join(", ");
    label = `${downServices.length} SERVICE${downServices.length > 1 ? "S" : ""} DOWN — ${names}`;
  } else {
    const names = degradedServices.map(([n]) => n.toUpperCase()).join(", ");
    label = `${degradedServices.length} DEGRADED — ${names}`;
  }

  return (
    <View
      style={{
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor,
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginBottom: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: borderColor,
        }}
      />
      <Text
        style={{
          fontFamily: "monospace",
          fontWeight: "700",
          fontSize: 12,
          letterSpacing: 1,
          color: textColor,
          flex: 1,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}
