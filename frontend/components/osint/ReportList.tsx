import { View, Text, Pressable, FlatList, ActivityIndicator } from "react-native";
import { useState, useEffect, useCallback } from "react";
import { fetchStoredReports, generateStoredReport, fetchStoredReport, type StoredReport, type StoredReportSummary } from "../../lib/bridge-api";
import { ReportModal } from "./ReportModal";

interface Props {
  onError?: (msg: string) => void;
}

export function ReportList({ onError }: Props) {
  const [reports, setReports] = useState<StoredReportSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedReport, setSelectedReport] = useState<{ markdown: string } | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);

  const loadReports = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchStoredReports();
      setReports(data);
    } catch (err: any) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleGenerate = async () => {
    try {
      setGenerating(true);
      await generateStoredReport();
      await loadReports();
    } catch (err: any) {
      onError?.(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleView = async (id: number) => {
    try {
      setModalLoading(true);
      setModalVisible(true);
      const report = await fetchStoredReport(id);
      setSelectedReport(report.data || report);
    } catch (err: any) {
      onError?.(err.message);
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
          📊 SAVED REPORTS
        </Text>
        <Pressable
          onPress={handleGenerate}
          disabled={generating}
          style={{ backgroundColor: "#1A1A2E", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: "#333" }}
        >
          <Text style={{ color: generating ? "#525252" : "#22C55E", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
            {generating ? "GENERATING..." : "+ NEW REPORT"}
          </Text>
        </Pressable>
      </View>

      {loading && reports.length === 0 && (
        <ActivityIndicator color="#06B6D4" size="small" />
      )}

      {!loading && reports.length === 0 && (
        <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", textAlign: "center", padding: 16 }}>
          No saved reports yet. Generate one to create a snapshot.
        </Text>
      )}

      {reports.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => handleView(r.id)}
          style={{
            backgroundColor: "#111111",
            borderWidth: 1,
            borderColor: "#222",
            borderRadius: 8,
            padding: 12,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }} numberOfLines={1}>
              {r.title}
            </Text>
            <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
              {r.report_type?.toUpperCase()} · {r.total_findings} findings · score {r.score_at_generation}
            </Text>
            <Text style={{ color: "#3B3B3B", fontSize: 9, fontFamily: "monospace" }}>
              {new Date(r.created_at).toLocaleDateString()} {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          </View>
          <Text style={{ color: "#525252", fontSize: 14, marginLeft: 8 }}>›</Text>
        </Pressable>
      ))}

      <ReportModal
        visible={modalVisible}
        onClose={() => { setModalVisible(false); setSelectedReport(null); }}
        report={selectedReport}
        loading={modalLoading}
      />
    </View>
  );
}
