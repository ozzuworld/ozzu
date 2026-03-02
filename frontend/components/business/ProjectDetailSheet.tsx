import { useState, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, Alert, LayoutAnimation } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { TaskCard } from "./TaskCard";
import { AddTaskModal } from "./AddTaskModal";
import { useBusinessProject } from "../../lib/business-hooks";
import {
  toggleBusinessTaskStatus,
  deleteBusinessTask,
  updateBusinessProject,
  archiveBusinessProject,
  type BusinessTask,
} from "../../lib/bridge-api";

const PROJECT_STATUSES = [
  { value: "active", label: "ACTIVE", color: "#22C55E" },
  { value: "paused", label: "PAUSED", color: "#EAB308" },
  { value: "completed", label: "COMPLETED", color: "#06B6D4" },
] as const;

interface ProjectDetailSheetProps {
  projectId: number | null;
  visible: boolean;
  onClose: () => void;
  onRefreshList: () => void;
}

export function ProjectDetailSheet({ projectId, visible, onClose, onRefreshList }: ProjectDetailSheetProps) {
  const { project, loading, reload: refresh } = useBusinessProject(projectId);
  const [addTaskVisible, setAddTaskVisible] = useState(false);

  const handleToggleTask = useCallback(async (taskId: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    await toggleBusinessTaskStatus(taskId);
    refresh();
    onRefreshList();
  }, [refresh, onRefreshList]);

  const handleDeleteTask = useCallback(async (task: BusinessTask) => {
    Alert.alert("Delete Task", `Delete "${task.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await deleteBusinessTask(task.id);
          refresh();
          onRefreshList();
        },
      },
    ]);
  }, [refresh, onRefreshList]);

  const handleStatusChange = useCallback(async (status: string) => {
    if (!projectId) return;
    await updateBusinessProject(projectId, { status } as any);
    refresh();
    onRefreshList();
  }, [projectId, refresh, onRefreshList]);

  const handleArchive = useCallback(async () => {
    if (!projectId) return;
    Alert.alert("Archive Project", "Archive this project? It will be hidden from the list.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive", style: "destructive", onPress: async () => {
          await archiveBusinessProject(projectId);
          onRefreshList();
          onClose();
        },
      },
    ]);
  }, [projectId, onRefreshList, onClose]);

  const tasks = project?.tasks || [];
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const totalTasks = tasks.length;
  const doneCount = doneTasks.length;
  const pct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ height: 80 }} onPress={onClose} />
        <View style={{ flex: 1, backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
          {/* Handle */}
          <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 8 }}>
            <View style={{ width: 40, height: 4, backgroundColor: "#333", borderRadius: 2 }} />
          </View>

          {loading || !project ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#525252", fontFamily: "monospace" }}>Loading...</Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
              {/* Project header */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <Text style={{ fontSize: 28 }}>{project.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>
                    {project.name}
                  </Text>
                  {project.description ? (
                    <Text style={{ color: "#737373", fontSize: 12, marginTop: 2 }}>{project.description}</Text>
                  ) : null}
                </View>
              </View>

              {/* Progress summary */}
              <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 14, marginBottom: 16 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
                  <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 11 }}>PROGRESS</Text>
                  <Text style={{ color: project.color || "#06B6D4", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{pct}%</Text>
                </View>
                <ProgressBar done={doneCount} total={totalTasks} color={project.color || "#06B6D4"} height={6} />
                <View style={{ flexDirection: "row", gap: 16, marginTop: 10 }}>
                  <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10 }}>
                    {pendingTasks.length} pending
                  </Text>
                  <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 10 }}>
                    {inProgressTasks.length} in progress
                  </Text>
                  <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 10 }}>
                    {doneCount} done
                  </Text>
                </View>
              </View>

              {/* Status toggles */}
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>STATUS</Text>
              <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
                {PROJECT_STATUSES.map((s) => (
                  <Pressable
                    key={s.value}
                    onPress={() => handleStatusChange(s.value)}
                    style={{
                      flex: 1,
                      paddingVertical: 6,
                      borderRadius: 6,
                      alignItems: "center",
                      backgroundColor: project.status === s.value ? s.color + "22" : "#1A1A1A",
                      borderWidth: 1,
                      borderColor: project.status === s.value ? s.color : "#2A2A2A",
                    }}
                  >
                    <Text style={{ color: project.status === s.value ? s.color : "#525252", fontFamily: "monospace", fontSize: 9, fontWeight: "bold" }}>
                      {s.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Add task button */}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 11, letterSpacing: 1 }}>
                  TASKS ({totalTasks})
                </Text>
                <Pressable onPress={() => setAddTaskVisible(true)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Text style={{ color: "#06B6D4", fontSize: 16 }}>+</Text>
                  <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11 }}>ADD</Text>
                </Pressable>
              </View>

              {/* In-progress tasks */}
              {inProgressTasks.length > 0 ? (
                <>
                  <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>IN PROGRESS</Text>
                  {inProgressTasks.map((t) => (
                    <TaskCard key={t.id} task={t} onToggle={() => handleToggleTask(t.id)} onPress={() => {}} onLongPress={() => handleDeleteTask(t)} />
                  ))}
                </>
              ) : null}

              {/* Pending tasks */}
              {pendingTasks.length > 0 ? (
                <>
                  <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4, marginTop: inProgressTasks.length > 0 ? 8 : 0 }}>PENDING</Text>
                  {pendingTasks.map((t) => (
                    <TaskCard key={t.id} task={t} onToggle={() => handleToggleTask(t.id)} onPress={() => {}} onLongPress={() => handleDeleteTask(t)} />
                  ))}
                </>
              ) : null}

              {/* Done tasks */}
              {doneTasks.length > 0 ? (
                <>
                  <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>COMPLETED</Text>
                  {doneTasks.map((t) => (
                    <TaskCard key={t.id} task={t} onToggle={() => handleToggleTask(t.id)} onPress={() => {}} onLongPress={() => handleDeleteTask(t)} />
                  ))}
                </>
              ) : null}

              {totalTasks === 0 ? (
                <View style={{ alignItems: "center", paddingVertical: 32 }}>
                  <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 12 }}>No tasks yet</Text>
                  <Pressable onPress={() => setAddTaskVisible(true)} style={{ marginTop: 8 }}>
                    <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 12 }}>+ Add your first task</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* Archive button */}
              <Pressable onPress={handleArchive} style={{ alignItems: "center", marginTop: 24, marginBottom: 40, paddingVertical: 8 }}>
                <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 11 }}>ARCHIVE PROJECT</Text>
              </Pressable>
            </ScrollView>
          )}

          <AddTaskModal
            visible={addTaskVisible}
            projectId={projectId || 0}
            onClose={() => setAddTaskVisible(false)}
            onCreated={() => { refresh(); onRefreshList(); }}
          />
        </View>
      </View>
    </Modal>
  );
}
