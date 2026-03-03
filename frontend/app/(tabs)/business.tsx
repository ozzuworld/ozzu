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
import { DashboardView } from "../../components/business/DashboardView";
import { PipelineView } from "../../components/business/PipelineView";
import { ContactsView } from "../../components/business/ContactsView";

const TOP_BAR_HEIGHT = 48;
const ACCENT = "#06B6D4";

const SUB_TABS = [
  { key: "dashboard", label: "DASHBOARD" },
  { key: "projects", label: "PROJECTS" },
  { key: "pipeline", label: "PIPELINE" },
  { key: "contacts", label: "CONTACTS" },
] as const;

type SubTab = typeof SUB_TABS[number]["key"];

export default function BusinessScreen() {
  const { insets } = usePhoneLayout();
  const { projects, loading, error, reload: refresh } = useBusiness();
  const [addVisible, setAddVisible] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<SubTab>("dashboard");

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const openProject = useCallback((id: number) => {
    setSelectedProjectId(id);
    setDetailVisible(true);
  }, []);

  // Aggregate stats for projects view
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
          zIndex: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <HamburgerMenu />
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>
            VENTURES
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {activeTab === "projects" && (
            <Pressable
              onPress={() => setAddVisible(true)}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? ACCENT + "22" : "transparent",
              })}
            >
              <Text style={{ color: ACCENT, fontSize: 22, lineHeight: 24 }}>+</Text>
            </Pressable>
          )}
          <StatusBadge />
        </View>
      </View>

      {/* Sub-tab navigation */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, backgroundColor: "#111111" }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {SUB_TABS.map((tab) => (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 6,
                  backgroundColor: activeTab === tab.key ? ACCENT + "22" : "transparent",
                  borderWidth: 1,
                  borderColor: activeTab === tab.key ? ACCENT + "44" : "transparent",
                }}
              >
                <Text
                  style={{
                    color: activeTab === tab.key ? ACCENT : "#525252",
                    fontFamily: "monospace",
                    fontSize: 10,
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  {tab.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* Content based on active tab */}
      {activeTab === "dashboard" && <DashboardView />}
      {activeTab === "pipeline" && <PipelineView />}
      {activeTab === "contacts" && <ContactsView />}
      {activeTab === "projects" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#525252" />}
        >
          {/* Overview card */}
          <View
            style={{
              backgroundColor: "#1A1A1A",
              borderRadius: 14,
              padding: 18,
              marginBottom: 20,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.04)",
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, letterSpacing: 2 }}>OVERVIEW</Text>
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 28, fontWeight: "bold", lineHeight: 32 }}>{overallPct}%</Text>
            </View>
            <ProgressBar done={totalDone} total={totalTasks} color={ACCENT} height={8} glow />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 14, paddingHorizontal: 4 }}>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{totalProjects}</Text>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>PROJECTS</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{totalTasks}</Text>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>TASKS</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{totalDone}</Text>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>DONE</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{totalInProgress}</Text>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>ACTIVE</Text>
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
              <Text style={{ color: "#525252", fontFamily: "monospace" }}>Loading ventures...</Text>
            </View>
          ) : projects.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ fontSize: 48, marginBottom: 16 }}>🚀</Text>
              <Text style={{ color: "#737373", fontSize: 15, marginBottom: 4 }}>No ventures yet</Text>
              <Text style={{ color: "#525252", fontSize: 12, marginBottom: 16, textAlign: "center", paddingHorizontal: 40 }}>
                Create your first project to start tracking
              </Text>
              <Pressable
                onPress={() => setAddVisible(true)}
                style={{
                  backgroundColor: ACCENT + "18",
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: ACCENT + "44",
                }}
              >
                <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>+ NEW PROJECT</Text>
              </Pressable>
            </View>
          ) : (
            projects.map((p) => (
              <ProjectCard key={p.id} project={p} onPress={() => openProject(p.id)} />
            ))
          )}
        </ScrollView>
      )}

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
