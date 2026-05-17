import { View, Text, Pressable } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { formatCOPCompact } from "./CostField";
import type { BusinessProject } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
const STATUS_COLOR: Record<string, string> = {
  active: colors.success,
  paused: colors.brand.amberDeep,
  completed: colors.accent,
};

interface ProjectCardProps {
  project: BusinessProject;
  onPress: () => void;
  onLongPress?: () => void;
}

export function ProjectCard({ project, onPress, onLongPress }: ProjectCardProps) {
  const statusColor = STATUS_COLOR[project.status] || STATUS_COLOR.active;
  const pct = project.task_count > 0 ? Math.round((project.done_count / project.task_count) * 100) : 0;
  const accentColor = project.color || colors.accent;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: 12,
          borderLeftWidth: 3,
          borderLeftColor: accentColor,
          marginBottom: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.04)",
        }}
      >
        {/* Header row */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
            <Text style={{ fontSize: 22 }}>{project.emoji}</Text>
            <Text style={{ color: colors.gray[50], fontSize: 15, fontWeight: "600", flex: 1 }} numberOfLines={1}>
              {project.name}
            </Text>
          </View>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
        </View>

        {/* Description */}
        {project.description ? (
          <Text style={{ color: colors.gray[300], fontSize: 12, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>
            {project.description}
          </Text>
        ) : null}

        {/* Budget utilization bar */}
        {project.budget && project.budget > 0 ? (
          <View style={{ marginBottom: 8 }}>
            <ProgressBar done={project.total_actual || 0} total={project.budget} color={((project.total_actual || 0) / project.budget) > 1 ? colors.error : ((project.total_actual || 0) / project.budget) > 0.8 ? colors.brand.amberDeep : colors.success} height={4} />
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 3 }}>
              {formatCOPCompact(project.total_actual || 0)} / {formatCOPCompact(project.budget)}
            </Text>
          </View>
        ) : null}

        {/* Progress */}
        <ProgressBar done={project.done_count} total={project.task_count} color={accentColor} height={5} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>
            {project.done_count}/{project.task_count} tasks
          </Text>
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
            {pct}%
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
