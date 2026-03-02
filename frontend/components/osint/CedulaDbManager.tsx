import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { TVPressable } from "../TVPressable";
import {
  fetchCedulaFaces,
  deleteCedulaFace,
  importCedulaFaces,
  type CedulaFaceRecord,
} from "../../lib/bridge-api";

type Props = {
  onClose: () => void;
};

export default function CedulaDbManager({ onClose }: Props) {
  const [records, setRecords] = useState<CedulaFaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [addCedula, setAddCedula] = useState("");
  const [addName, setAddName] = useState("");
  const [importing, setImporting] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCedulaFaces(100, 0);
      setRecords(data.records);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const handleAdd = async () => {
    if (!addCedula.trim()) return;
    setImporting(true);
    try {
      await importCedulaFaces([{ cedula: addCedula.trim(), fullName: addName.trim() || undefined }]);
      setAddCedula("");
      setAddName("");
      await loadRecords();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (cedula: string) => {
    try {
      await deleteCedulaFace(cedula);
      await loadRecords();
    } catch {}
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#111111", padding: 16 }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>
          FACE DATABASE
        </Text>
        <TVPressable onPress={onClose} style={{ padding: 8 }}>
          <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace" }}>CLOSE</Text>
        </TVPressable>
      </View>

      {/* Add entry */}
      <View style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, marginBottom: 12, gap: 8 }}>
        <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
          ADD ENTRY
        </Text>
        <TextInput
          placeholder="Cedula #"
          placeholderTextColor="#525252"
          value={addCedula}
          onChangeText={setAddCedula}
          keyboardType="numeric"
          style={{
            backgroundColor: "#111",
            borderWidth: 1,
            borderColor: "#333",
            borderRadius: 6,
            padding: 10,
            color: "#FFF",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        />
        <TextInput
          placeholder="Full name (optional)"
          placeholderTextColor="#525252"
          value={addName}
          onChangeText={setAddName}
          style={{
            backgroundColor: "#111",
            borderWidth: 1,
            borderColor: "#333",
            borderRadius: 6,
            padding: 10,
            color: "#FFF",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        />
        <TVPressable
          onPress={handleAdd}
          style={{
            backgroundColor: importing ? "#333" : "#06B6D4",
            paddingVertical: 10,
            borderRadius: 6,
            alignItems: "center",
          }}
        >
          <Text style={{ color: importing ? "#737373" : "#000", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
            {importing ? "ADDING..." : "ADD TO DB"}
          </Text>
        </TVPressable>
      </View>

      {/* Count */}
      <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", marginBottom: 8, letterSpacing: 1 }}>
        {loading ? "LOADING..." : `${records.length} RECORDS`}
      </Text>

      {/* List */}
      {loading ? (
        <ActivityIndicator size="small" color="#06B6D4" />
      ) : (
        <ScrollView style={{ flex: 1 }}>
          {records.map((rec) => (
            <View
              key={rec.id}
              style={{
                backgroundColor: "#1A1A1A",
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#FFF", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                  {rec.full_name || "Unknown"}
                </Text>
                <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace" }}>
                  CC {rec.cedula}
                </Text>
                <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>
                  {rec.photo_path ? "Has photo" : "No photo"} | {new Date(rec.created_at).toLocaleDateString()}
                </Text>
              </View>
              <TVPressable
                onPress={() => handleDelete(rec.cedula)}
                style={{ padding: 8 }}
              >
                <Text style={{ color: "#EF4444", fontSize: 10, fontFamily: "monospace" }}>DEL</Text>
              </TVPressable>
            </View>
          ))}
          {records.length === 0 && (
            <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace", textAlign: "center", marginTop: 24 }}>
              No faces in database yet.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}
