import { View, Text, Pressable } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { formatCOPCompact } from "./CostField";
import type { BusinessProject } from "../../lib/bridge-api";

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  active: { label: "ACTIVE", color: "#22C55E" },
  paused: { label: "PAUSED", color: "#EAB308" },
  completed: { label: "DONE", color: "#06B6D4" },
};

interface ProjectCardProps {
  project: BusinessProject;
  onPress: () => void;
  onLongPress?: () => void;
}

export function ProjectCard({ project, onPress, onLongPress }: ProjectCardProps) {
  const badge = STATUS_BADGE[project.status] || STATUS_BADGE.active;
  const pct = project.task_count > 0 ? Math.round((project.done_count / project.task_count) * 100) : 0;

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress}>
      <View
        style={{
          backgroundColor: "#1A1A1A",
          borderRadius: 10,
          borderLeftWidth: 3,
          borderLeftColor: project.color || "#06B6D4",
          marginBottom: 10,
          padding: 14,
        }}
      >
        {/* Header row */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
            <Text style={{ fontSize: 20 }}>{project.emoji}</Text>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", flex: 1 }} numberOfLines={1}>
              {project.name}
            </Text>
          </View>
          <View style={{ backgroundColor: badge.color + "22", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
            <Text style={{ color: badge.color, fontFamily: "monospace", fontSize: 9, fontWeight: "bold", letterSpacing: 1 }}>
              {badge.label}
            </Text>
          </View>
        </View>

        {/* Description */}
        {project.description ? (
          <Text style={{ color: "#737373", fontSize: 12, marginBottom: 8 }} numberOfLines={2}>
            {project.description}
          </Text>
        ) : null}

        {/* Budget utilization bar */}
        {project.budget && project.budget > 0 ? (
          <View style={{ marginBottom: 6 }}>
            <ProgressBar done={project.total_actual || 0} total={project.budget} color={((project.total_actual || 0) / project.budget) > 1 ? "#EF4444" : ((project.total_actual || 0) / project.budget) > 0.8 ? "#EAB308" : "#22C55E"} height={3} />
            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>
              {formatCOPCompact(project.total_actual || 0)} / {formatCOPCompact(project.budget)}
            </Text>
          </View>
        ) : null}

        {/* Progress */}
        <ProgressBar done={project.done_count} total={project.task_count} color={project.color || "#06B6D4"} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10 }}>
            {project.done_count}/{project.task_count} tasks
          </Text>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10 }}>
            {pct}%
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
