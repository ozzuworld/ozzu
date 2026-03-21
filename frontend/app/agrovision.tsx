import { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { getBridgeUrl } from "../lib/bridge-api";

const { width: SCREEN_W } = Dimensions.get("window");
const TOP_BAR_HEIGHT = 52;

// Colors
const GREEN = "#22C55E";
const CYAN = "#06B6D4";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const CARD_BG = "#0A0A0A";
const BORDER = "#151515";

const SEVERITY_COLORS: Record<string, string> = {
  critical: RED,
  high: "#F97316",
  moderate: AMBER,
  low: GREEN,
  none: GREEN,
  unknown: "#6B7280",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  moderate: "MODERATE",
  low: "LOW",
  none: "HEALTHY",
  unknown: "UNKNOWN",
};

interface DiseaseMatch {
  disease_id: string;
  disease_name: string;
  scientific_name: string;
  crop: string;
  severity: string;
  treatment: string;
  prevention: string;
  confidence: number;
  avg_similarity: number;
  reference_count: number;
}

interface SearchResult {
  prediction: {
    disease: string;
    confidence: number;
    severity: string;
    crop: string;
  } | null;
  matches: DiseaseMatch[];
  total_matches: number;
}

interface ScanHistoryItem {
  id: string;
  imageUri: string;
  result: SearchResult;
  timestamp: number;
}

export default function AgroVisionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isPhone = usePhoneLayout();

  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const [expandedMatch, setExpandedMatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickImage = useCallback(async (useCamera: boolean) => {
    setError(null);
    setResult(null);

    let pickerResult;
    if (useCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Camera access is required to scan leaves.");
        return;
      }
      pickerResult = await ImagePicker.launchCameraAsync({
        quality: 0.8,
        allowsEditing: true,
        aspect: [1, 1],
      });
    } else {
      pickerResult = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        quality: 0.8,
        allowsEditing: true,
        aspect: [1, 1],
      });
    }

    if (pickerResult.canceled || !pickerResult.assets?.[0]) return;

    const uri = pickerResult.assets[0].uri;
    setSelectedImage(uri);
    analyzePlant(uri);
  }, []);

  const analyzePlant = useCallback(async (imageUri: string) => {
    setScanning(true);
    setError(null);
    setResult(null);

    try {
      const base64 = await FileSystem.readAsStringAsync(imageUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const bridgeUrl = getBridgeUrl();
      const formData = new FormData();
      formData.append("base64_image", `data:image/jpeg;base64,${base64}`);
      formData.append("top_k", "5");
      formData.append("threshold", "0.25");

      const response = await fetch(`${bridgeUrl}/plant/search`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const data: SearchResult = await response.json();
      setResult(data);

      // Add to history
      setHistory((prev) => [
        {
          id: Date.now().toString(),
          imageUri,
          result: data,
          timestamp: Date.now(),
        },
        ...prev.slice(0, 19),
      ]);
    } catch (e: any) {
      setError(e.message || "Failed to analyze image");
    } finally {
      setScanning(false);
    }
  }, []);

  const renderSeverityBadge = (severity: string) => {
    const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
    const label = SEVERITY_LABELS[severity] || severity.toUpperCase();
    return (
      <View style={[styles.severityBadge, { borderColor: color }]}>
        <View style={[styles.severityDot, { backgroundColor: color }]} />
        <Text style={[styles.severityText, { color }]}>{label}</Text>
      </View>
    );
  };

  const renderPrediction = () => {
    if (!result?.prediction) return null;
    const { disease, confidence, severity, crop } = result.prediction;
    const isHealthy = severity === "none" || disease === "Healthy";
    const color = isHealthy ? GREEN : SEVERITY_COLORS[severity] || AMBER;

    return (
      <View style={[styles.predictionCard, { borderColor: color + "40" }]}>
        <View style={styles.predictionHeader}>
          <Text style={styles.predictionEmoji}>
            {isHealthy ? "\u2705" : severity === "critical" ? "\u26a0\ufe0f" : "\ud83c\udf3f"}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.predictionDisease, { color }]}>{disease}</Text>
            <Text style={styles.predictionCrop}>{crop}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.confidenceValue, { color }]}>
              {(confidence * 100).toFixed(1)}%
            </Text>
            {renderSeverityBadge(severity)}
          </View>
        </View>
      </View>
    );
  };

  const renderMatchCard = (match: DiseaseMatch, index: number) => {
    const isExpanded = expandedMatch === match.disease_id;
    const color = SEVERITY_COLORS[match.severity] || SEVERITY_COLORS.unknown;

    return (
      <Pressable
        key={match.disease_id}
        style={[styles.matchCard, index === 0 && { borderColor: color + "30" }]}
        onPress={() => setExpandedMatch(isExpanded ? null : match.disease_id)}
      >
        <View style={styles.matchHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.matchName}>{match.disease_name}</Text>
            {match.scientific_name ? (
              <Text style={styles.matchScientific}>{match.scientific_name}</Text>
            ) : null}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.matchConfidence, { color }]}>
              {(match.confidence * 100).toFixed(1)}%
            </Text>
            <Text style={styles.matchRefs}>
              {match.reference_count} ref{match.reference_count !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {isExpanded && (
          <View style={styles.matchDetails}>
            <View style={styles.matchDetailRow}>
              <Text style={styles.matchDetailLabel}>Crop</Text>
              <Text style={styles.matchDetailValue}>{match.crop}</Text>
            </View>
            {renderSeverityBadge(match.severity)}

            {match.treatment ? (
              <View style={styles.treatmentSection}>
                <Text style={styles.treatmentTitle}>Treatment</Text>
                <Text style={styles.treatmentText}>{match.treatment}</Text>
              </View>
            ) : null}

            {match.prevention ? (
              <View style={styles.treatmentSection}>
                <Text style={styles.preventionTitle}>Prevention</Text>
                <Text style={styles.treatmentText}>{match.prevention}</Text>
              </View>
            ) : null}
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="light" />

      {/* Top Bar */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backButton}>{"\u2190"}</Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.title}>AgroVisi{"\u00f3"}n</Text>
          <Text style={styles.subtitle}>Crop Disease Detection</Text>
        </View>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
      >
        {/* Image Preview */}
        {selectedImage ? (
          <View style={styles.imageContainer}>
            <Image
              source={{ uri: selectedImage }}
              style={styles.previewImage}
              resizeMode="cover"
            />
            {scanning && (
              <View style={styles.scanningOverlay}>
                <ActivityIndicator size="large" color={GREEN} />
                <Text style={styles.scanningText}>Analyzing leaf...</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.placeholderContainer}>
            <Text style={styles.placeholderEmoji}>{"\ud83c\udf3f"}</Text>
            <Text style={styles.placeholderTitle}>Scan a Leaf</Text>
            <Text style={styles.placeholderText}>
              Take a photo or choose from gallery to identify crop diseases
            </Text>
          </View>
        )}

        {/* Action Buttons */}
        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.actionButton, styles.cameraButton]}
            onPress={() => pickImage(true)}
            disabled={scanning}
          >
            <Text style={styles.buttonEmoji}>{"\ud83d\udcf7"}</Text>
            <Text style={styles.buttonText}>Camera</Text>
          </Pressable>
          <Pressable
            style={[styles.actionButton, styles.galleryButton]}
            onPress={() => pickImage(false)}
            disabled={scanning}
          >
            <Text style={styles.buttonEmoji}>{"\ud83d\uddbc\ufe0f"}</Text>
            <Text style={styles.buttonText}>Gallery</Text>
          </Pressable>
        </View>

        {/* Error */}
        {error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Result */}
        {result && (
          <View style={styles.resultsSection}>
            {renderPrediction()}

            {result.matches.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  All Matches ({result.total_matches})
                </Text>
                {result.matches.map((m, i) => renderMatchCard(m, i))}
              </>
            )}

            {result.matches.length === 0 && (
              <View style={styles.noMatchCard}>
                <Text style={styles.noMatchText}>
                  No matching diseases found. The leaf may be healthy or the disease isn't in our database yet.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* History */}
        {history.length > 0 && !result && (
          <View style={styles.historySection}>
            <Text style={styles.sectionTitle}>Recent Scans</Text>
            {history.map((item) => (
              <Pressable
                key={item.id}
                style={styles.historyCard}
                onPress={() => {
                  setSelectedImage(item.imageUri);
                  setResult(item.result);
                }}
              >
                <Image
                  source={{ uri: item.imageUri }}
                  style={styles.historyThumb}
                />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.historyDisease}>
                    {item.result.prediction?.disease || "Unknown"}
                  </Text>
                  <Text style={styles.historyMeta}>
                    {item.result.prediction?.crop} {"\u00b7"}{" "}
                    {((item.result.prediction?.confidence || 0) * 100).toFixed(0)}%
                  </Text>
                  <Text style={styles.historyTime}>
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </Text>
                </View>
                {item.result.prediction &&
                  renderSeverityBadge(item.result.prediction.severity)}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111111" },
  topBar: {
    height: TOP_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  backButton: { color: "#9CA3AF", fontSize: 20, fontFamily: "monospace" },
  title: { color: GREEN, fontSize: 16, fontWeight: "700", fontFamily: "monospace" },
  subtitle: { color: "#525252", fontSize: 10, fontFamily: "monospace" },
  content: { flex: 1, paddingHorizontal: 16 },

  // Image preview
  imageContainer: { marginTop: 16, borderRadius: 12, overflow: "hidden", position: "relative" },
  previewImage: {
    width: "100%" as any,
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: "#0A0A0A",
  },
  scanningOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  scanningText: { color: GREEN, fontSize: 14, fontFamily: "monospace", marginTop: 12 },

  // Placeholder
  placeholderContainer: {
    marginTop: 40,
    alignItems: "center",
    paddingVertical: 48,
  },
  placeholderEmoji: { fontSize: 64, marginBottom: 16 },
  placeholderTitle: { color: "#E5E7EB", fontSize: 20, fontWeight: "600", fontFamily: "monospace" },
  placeholderText: {
    color: "#6B7280",
    fontSize: 13,
    fontFamily: "monospace",
    textAlign: "center",
    marginTop: 8,
    paddingHorizontal: 32,
  },

  // Buttons
  buttonRow: { flexDirection: "row", gap: 12, marginTop: 16 },
  actionButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  cameraButton: { backgroundColor: GREEN + "15", borderWidth: 1, borderColor: GREEN + "30" },
  galleryButton: { backgroundColor: CYAN + "15", borderWidth: 1, borderColor: CYAN + "30" },
  buttonEmoji: { fontSize: 18 },
  buttonText: { color: "#E5E7EB", fontSize: 14, fontWeight: "600", fontFamily: "monospace" },

  // Error
  errorCard: {
    marginTop: 16,
    padding: 16,
    backgroundColor: RED + "10",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: RED + "30",
  },
  errorText: { color: RED, fontSize: 13, fontFamily: "monospace" },

  // Results
  resultsSection: { marginTop: 20 },
  sectionTitle: {
    color: "#9CA3AF",
    fontSize: 12,
    fontFamily: "monospace",
    fontWeight: "600",
    marginBottom: 12,
    marginTop: 16,
    textTransform: "uppercase",
    letterSpacing: 1,
  },

  // Prediction card
  predictionCard: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  predictionHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  predictionEmoji: { fontSize: 32 },
  predictionDisease: { fontSize: 18, fontWeight: "700", fontFamily: "monospace" },
  predictionCrop: { color: "#6B7280", fontSize: 12, fontFamily: "monospace", marginTop: 2 },
  confidenceValue: { fontSize: 20, fontWeight: "700", fontFamily: "monospace" },

  // Severity badge
  severityBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  severityDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  severityText: { fontSize: 10, fontWeight: "700", fontFamily: "monospace" },

  // Match cards
  matchCard: {
    backgroundColor: CARD_BG,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: BORDER,
  },
  matchHeader: { flexDirection: "row", alignItems: "center" },
  matchName: { color: "#E5E7EB", fontSize: 14, fontWeight: "600", fontFamily: "monospace" },
  matchScientific: { color: "#525252", fontSize: 11, fontFamily: "monospace", fontStyle: "italic", marginTop: 2 },
  matchConfidence: { fontSize: 15, fontWeight: "700", fontFamily: "monospace" },
  matchRefs: { color: "#525252", fontSize: 10, fontFamily: "monospace", marginTop: 2 },

  // Match details (expanded)
  matchDetails: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: BORDER },
  matchDetailRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  matchDetailLabel: { color: "#6B7280", fontSize: 12, fontFamily: "monospace" },
  matchDetailValue: { color: "#D1D5DB", fontSize: 12, fontFamily: "monospace" },

  treatmentSection: { marginTop: 12 },
  treatmentTitle: { color: AMBER, fontSize: 12, fontWeight: "700", fontFamily: "monospace", marginBottom: 4 },
  preventionTitle: { color: GREEN, fontSize: 12, fontWeight: "700", fontFamily: "monospace", marginBottom: 4 },
  treatmentText: { color: "#9CA3AF", fontSize: 12, fontFamily: "monospace", lineHeight: 18 },

  // No match
  noMatchCard: {
    backgroundColor: CARD_BG,
    borderRadius: 10,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: BORDER,
  },
  noMatchText: { color: "#6B7280", fontSize: 13, fontFamily: "monospace", textAlign: "center" },

  // History
  historySection: { marginTop: 24 },
  historyCard: {
    backgroundColor: CARD_BG,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: BORDER,
    flexDirection: "row",
    alignItems: "center",
  },
  historyThumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: "#1a1a1a" },
  historyDisease: { color: "#E5E7EB", fontSize: 13, fontWeight: "600", fontFamily: "monospace" },
  historyMeta: { color: "#6B7280", fontSize: 11, fontFamily: "monospace", marginTop: 2 },
  historyTime: { color: "#525252", fontSize: 10, fontFamily: "monospace", marginTop: 2 },
});
