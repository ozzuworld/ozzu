import { useState, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, Alert, LayoutAnimation } from "react-native";
import { ProgressBar } from "./ProgressBar";
import { TaskCard } from "./TaskCard";
import { TaskDetailSheet } from "./TaskDetailSheet";
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

type ViewMode = "phases" | "status";

interface ProjectDetailSheetProps {
  projectId: number | null;
  visible: boolean;
  onClose: () => void;
  onRefreshList: () => void;
}

export function ProjectDetailSheet({ projectId, visible, onClose, onRefreshList }: ProjectDetailSheetProps) {
  const { project, loading, reload: refresh, editTask, uploadAttachment, removeAttachment } = useBusinessProject(projectId);
  const [addTaskVisible, setAddTaskVisible] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("phases");
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [detailTask, setDetailTask] = useState<BusinessTask | null>(null);

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
          setDetailTask(null);
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

  const handleEditTask = useCallback(async (taskId: number, data: Partial<BusinessTask>) => {
    await editTask(taskId, data);
    // Update the detail task inline so changes are reflected immediately
    setDetailTask((prev) => prev && prev.id === taskId ? { ...prev, ...data } : prev);
  }, [editTask]);

  const handleUploadAttachment = useCallback(async (taskId: number, base64: string, fileName: string, fileType?: string) => {
    return uploadAttachment(taskId, base64, fileName, fileType);
  }, [uploadAttachment]);

  const handleRemoveAttachment = useCallback(async (id: number) => {
    await removeAttachment(id);
  }, [removeAttachment]);

  const togglePhaseCollapse = (phase: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      next.has(phase) ? next.delete(phase) : next.add(phase);
      return next;
    });
  };

  const tasks = project?.tasks || [];
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const totalTasks = tasks.length;
  const doneCount = doneTasks.length;
  const pct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  // Group tasks by phase
  const phaseGroups = new Map<string, BusinessTask[]>();
  for (const t of tasks) {
    const phase = t.phase || "Uncategorized";
    if (!phaseGroups.has(phase)) phaseGroups.set(phase, []);
    phaseGroups.get(phase)!.push(t);
  }

  // Get unique phases for AddTaskModal
  const existingPhases = [...new Set(tasks.map((t) => t.phase).filter(Boolean))] as string[];

  const hasPhases = existingPhases.length > 0;

  const renderTaskCard = (t: BusinessTask) => (
    <TaskCard
      key={t.id}
      task={t}
      onToggle={() => handleToggleTask(t.id)}
      onPress={() => setDetailTask(t)}
      onLongPress={() => handleDeleteTask(t)}
    />
  );

  const renderPhaseView = () => (
    <>
      {[...phaseGroups.entries()].map(([phase, phaseTasks]) => {
        const phaseDone = phaseTasks.filter((t) => t.status === "done").length;
        const isCollapsed = collapsedPhases.has(phase);
        return (
          <View key={phase} style={{ marginBottom: 12 }}>
            <Pressable
              onPress={() => togglePhaseCollapse(phase)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingVertical: 6,
                paddingHorizontal: 4,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={{ color: "#525252", fontSize: 10 }}>{isCollapsed ? "▶" : "▼"}</Text>
                <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>
                  {phase}
                </Text>
              </View>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>
                {phaseDone}/{phaseTasks.length}
              </Text>
            </Pressable>
            {!isCollapsed ? phaseTasks.map(renderTaskCard) : null}
          </View>
        );
      })}
    </>
  );

  const renderStatusView = () => (
    <>
      {inProgressTasks.length > 0 ? (
        <>
          <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>IN PROGRESS</Text>
          {inProgressTasks.map(renderTaskCard)}
        </>
      ) : null}
      {pendingTasks.length > 0 ? (
        <>
          <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4, marginTop: inProgressTasks.length > 0 ? 8 : 0 }}>PENDING</Text>
          {pendingTasks.map(renderTaskCard)}
        </>
      ) : null}
      {doneTasks.length > 0 ? (
        <>
          <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>COMPLETED</Text>
          {doneTasks.map(renderTaskCard)}
        </>
      ) : null}
    </>
  );

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

              {/* Task header + view toggle + add button */}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 11, letterSpacing: 1 }}>
                    TASKS ({totalTasks})
                  </Text>
                  {hasPhases ? (
                    <View style={{ flexDirection: "row", gap: 2 }}>
                      {(["phases", "status"] as const).map((mode) => (
                        <Pressable
                          key={mode}
                          onPress={() => setViewMode(mode)}
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                            borderRadius: 4,
                            backgroundColor: viewMode === mode ? "#2A2A2A" : "transparent",
                          }}
                        >
                          <Text style={{
                            color: viewMode === mode ? "#E5E5E5" : "#525252",
                            fontFamily: "monospace",
                            fontSize: 9,
                            fontWeight: "bold",
                          }}>
                            {mode.toUpperCase()}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
                <Pressable onPress={() => setAddTaskVisible(true)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Text style={{ color: "#06B6D4", fontSize: 16 }}>+</Text>
                  <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11 }}>ADD</Text>
                </Pressable>
              </View>

              {/* Task list */}
              {viewMode === "phases" && hasPhases ? renderPhaseView() : renderStatusView()}

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
            existingPhases={existingPhases}
            onClose={() => setAddTaskVisible(false)}
            onCreated={() => { refresh(); onRefreshList(); }}
          />

          <TaskDetailSheet
            task={detailTask}
            visible={detailTask !== null}
            onClose={() => setDetailTask(null)}
            onToggle={(id) => { handleToggleTask(id); setDetailTask(null); }}
            onEdit={handleEditTask}
            onDelete={handleDeleteTask}
            onUpload={handleUploadAttachment}
            onRemoveAttachment={handleRemoveAttachment}
          />
        </View>
      </View>
    </Modal>
  );
}
