import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { colors, fontSize as fs, fontWeight as fw, withAlpha } from "../lib/design-tokens";

type GroupKey = "cipher" | "work" | "me" | "ops";

type Entry = { icon: string; label: string; route: string };

const GROUPS: Record<GroupKey, Entry[]> = {
  cipher: [
    { icon: "▶", label: "Directives", route: "/directives" },
    { icon: "🎙️", label: "Voice", route: "/cipher" },
    { icon: "🧠", label: "Training", route: "/training" },
    { icon: "📊", label: "Metrics", route: "/metrics" },
  ],
  work: [
    { icon: "🚀", label: "Ventures", route: "/business" },
    { icon: "📋", label: "Licitaciones", route: "/secop" },
    { icon: "🔐", label: "SOC", route: "/soc" },
  ],
  me: [
    { icon: "🪪", label: "Identity", route: "/identity" },
    { icon: "💰", label: "Finance", route: "/finance" },
    { icon: "📦", label: "Files", route: "/files" },
    { icon: "💾", label: "Backups", route: "/backup" },
  ],
  ops: [
    { icon: "🖥️", label: "Infra", route: "/ops" },
    { icon: "👓", label: "Glasses", route: "/glasses" },
  ],
};

export function GroupNav({ group }: { group: GroupKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const entries = GROUPS[group];

  return (
    <View
      style={{
        borderBottomWidth: 0.5,
        borderBottomColor: withAlpha("#ffffff", 0.06),
        backgroundColor: colors.bg.base,
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", paddingHorizontal: 12 }}>
          {entries.map((e) => {
            const active = pathname === e.route || pathname.startsWith(e.route + "/");
            return (
              <Pressable
                key={e.route}
                onPress={() => {
                  if (!active) router.replace(e.route as any);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  borderBottomWidth: 2,
                  borderBottomColor: active ? colors.accent : "transparent",
                }}
              >
                <Text style={{ fontSize: 13 }}>{e.icon}</Text>
                <Text
                  style={{
                    color: active ? colors.text.primary : colors.text.disabled,
                    fontSize: fs.sm,
                    fontWeight: active ? fw.semibold : fw.normal,
                    letterSpacing: 0.2,
                  }}
                >
                  {e.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
