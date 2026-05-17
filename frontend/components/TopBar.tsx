import React from "react";
import { View, Text } from "react-native";
import { HamburgerMenu } from "./HamburgerMenu";
import { StatusBadge } from "./StatusBadge";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { colors, fontSize as fs, fontWeight as fw, layout } from "../lib/design-tokens";

type Props = {
  title?: string | React.ReactNode;
  titleColor?: string;
  titleSize?: number;
  titleWeight?: "normal" | "medium" | "semibold" | "bold";
  letterSpacing?: number;
  left?: React.ReactNode;
  right?: React.ReactNode;
  background?: string;
  borderBottom?: boolean;
};

export function TopBar({
  title,
  titleColor = colors.text.primary,
  titleSize = fs.lg,
  titleWeight = "semibold",
  letterSpacing,
  left,
  right,
  background,
  borderBottom = false,
}: Props) {
  const { insets } = usePhoneLayout();
  const hPad = Math.max(16, insets.left, insets.right);

  return (
    <View
      style={{
        paddingTop: insets.top,
        height: layout.topBarHeight + insets.top,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: hPad,
        backgroundColor: background,
        borderBottomWidth: borderBottom ? 1 : 0,
        borderBottomColor: colors.border.subtle,
        zIndex: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
        {left ?? <HamburgerMenu />}
        {title != null &&
          (typeof title === "string" ? (
            <Text
              style={{
                color: titleColor,
                fontSize: titleSize,
                fontWeight: fw[titleWeight],
                letterSpacing,
              }}
            >
              {title}
            </Text>
          ) : (
            title
          ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {right ?? <StatusBadge />}
      </View>
    </View>
  );
}
