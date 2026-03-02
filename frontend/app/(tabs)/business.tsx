import { useState, useCallback } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../../components/StatusBadge";
import { HamburgerMenu } from "../../components/HamburgerMenu";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useBusiness } from "../../lib/business-hooks";
import { ProjectCard } from "../../components/business/ProjectCard";
import { AddProjectModal } from "../../components/business/AddProjectModal";
import { ProjectDetailSheet } from "../../components/business/ProjectDetailSheet";
import { ProgressBar } from "../../components/business/ProgressBar";

const TOP_BAR_HEIGHT = 48;
const ACCENT = "#06B6D4";

export default function BusinessScreen() {
  const { insets } = usePhoneLayout();
  const { projects, loading, error, reload: refresh } = useBusiness();
  const [addVisible, setAddVisible] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const openProject = useCallback((id: number) => {
    setSelectedProjectId(id);
    setDetailVisible(true);
  }, []);

  // Aggregate stats
  const totalProjects = projects.length;
  const totalTasks = projects.reduce((s, p) => s + p.task_count, 0);
  const totalDone = projects.reduce((s, p) => s + p.done_count, 0);
  const totalInProgress = projects.reduce((s, p) => s + p.in_progress_count, 0);
  const overallPct = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: TOP_BAR_HEIGHT + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(16, insets.left, insets.right),
          backgroundColor: "#111111",
          borderBottomWidth: 1,
          borderBottomColor: "#222",
          zIndex: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <HamburgerMenu />
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2 }}>
            BUSINESS
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable onPress={() => setAddVisible(true)}>
            <Text style={{ color: ACCENT, fontSize: 22 }}>+</Text>
          </Pressable>
          <StatusBadge />
        </View>
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#525252" />}
      >
        {/* Summary card */}
        <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 11, letterSpacing: 1 }}>OVERVIEW</Text>
            <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{overallPct}%</Text>
          </View>
          <ProgressBar done={totalDone} total={totalTasks} color={ACCENT} height={5} />
          <View style={{ flexDirection: "row", gap: 16, marginTop: 10 }}>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>{totalProjects}</Text>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>PROJECTS</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>{totalTasks}</Text>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>TASKS</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>{totalDone}</Text>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>DONE</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>{totalInProgress}</Text>
              <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>ACTIVE</Text>
            </View>
          </View>
        </View>

        {/* Error state */}
        {error ? (
          <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 16, marginBottom: 16, borderLeftWidth: 3, borderLeftColor: "#EF4444" }}>
            <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 11 }}>{error}</Text>
          </View>
        ) : null}

        {/* Projects list */}
        {loading && projects.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ color: "#525252", fontFamily: "monospace" }}>Loading projects...</Text>
          </View>
        ) : projects.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 60 }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>📋</Text>
            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 13, marginBottom: 8 }}>No projects yet</Text>
            <Pressable onPress={() => setAddVisible(true)}>
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 13 }}>+ Create your first project</Text>
            </Pressable>
          </View>
        ) : (
          projects.map((p) => (
            <ProjectCard key={p.id} project={p} onPress={() => openProject(p.id)} />
          ))
        )}
      </ScrollView>

      {/* Modals */}
      <AddProjectModal visible={addVisible} onClose={() => setAddVisible(false)} onCreated={refresh} />
      <ProjectDetailSheet
        projectId={selectedProjectId}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onRefreshList={refresh}
      />

      <StatusBar style="light" />
    </View>
  );
}
