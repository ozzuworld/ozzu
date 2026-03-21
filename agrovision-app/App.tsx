import { useState, useEffect, useCallback } from "react";
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
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useTensorflowModel } from "react-native-fast-tflite";
import * as jpeg from "jpeg-js";

import classifierMeta from "./assets/models/classifier_metadata.json";
import diseaseData from "./assets/models/disease_metadata.json";

const CLASS_TO_DISEASE: Record<string, string> = {
  Anthracnose: "anthracnose",
  Apple___Apple_scab: "apple_scab",
  Apple___Black_rot: "apple_black_rot",
  Apple___Cedar_apple_rust: "apple_cedar_rust",
  Apple___healthy: "healthy",
  Bacterial_Canker: "bacterial_canker",
  Blueberry___healthy: "healthy",
  "Cherry_(including_sour)___Powdery_mildew": "cherry_powdery_mildew",
  "Cherry_(including_sour)___healthy": "healthy",
  "Corn_(maize)___Cercospora_leaf_spot_Gray_leaf_spot": "corn_cercospora",
  "Corn_(maize)___Common_rust_": "corn_common_rust",
  "Corn_(maize)___Northern_Leaf_Blight": "corn_northern_blight",
  "Corn_(maize)___healthy": "healthy",
  Cutting_Weevil: "cutting_weevil",
  Die_Back: "die_back",
  Gall_Midge: "gall_midge",
  "Grape___Black_rot": "grape_black_rot",
  "Grape___Esca_(Black_Measles)": "grape_esca",
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)": "grape_leaf_blight",
  Grape___healthy: "healthy",
  Healthy: "healthy",
  "Orange___Haunglongbing_(Citrus_greening)": "citrus_greening",
  Peach___Bacterial_spot: "peach_bacterial_spot",
  Peach___healthy: "healthy",
  "Pepper,_bell___Bacterial_spot": "pepper_bacterial_spot",
  "Pepper,_bell___healthy": "healthy",
  Potato___Early_blight: "potato_early_blight",
  Potato___Late_blight: "potato_late_blight",
  Potato___healthy: "healthy",
  Powdery_Mildew: "powdery_mildew",
  Raspberry___healthy: "healthy",
  Sooty_Mould: "sooty_mould",
  Soybean___healthy: "healthy",
  Squash___Powdery_mildew: "squash_powdery_mildew",
  Strawberry___Leaf_scorch: "strawberry_leaf_scorch",
  Strawberry___healthy: "healthy",
  Tomato___Bacterial_spot: "tomato_bacterial_spot",
  Tomato___Early_blight: "tomato_early_blight",
  Tomato___Late_blight: "tomato_late_blight",
  Tomato___Leaf_Mold: "tomato_leaf_mold",
  Tomato___Septoria_leaf_spot: "tomato_septoria",
  "Tomato___Spider_mites_Two-spotted_spider_mite": "tomato_spider_mites",
  Tomato___Target_Spot: "tomato_target_spot",
  Tomato___Tomato_Yellow_Leaf_Curl_Virus: "tomato_yellow_curl",
  Tomato___Tomato_mosaic_virus: "tomato_mosaic",
  Tomato___healthy: "healthy",
};

const CLASS_NAMES_ES: Record<string, string> = {
  Anthracnose: "Antracnosis",
  Apple___Apple_scab: "Sarna del Manzano",
  Apple___Black_rot: "Pudrición Negra del Manzano",
  Apple___Cedar_apple_rust: "Roya del Manzano",
  Apple___healthy: "Manzano Sano",
  Bacterial_Canker: "Cancro Bacteriano",
  Blueberry___healthy: "Arándano Sano",
  "Cherry_(including_sour)___Powdery_mildew": "Oídio del Cerezo",
  "Cherry_(including_sour)___healthy": "Cerezo Sano",
  "Corn_(maize)___Cercospora_leaf_spot_Gray_leaf_spot": "Mancha Gris del Maíz",
  "Corn_(maize)___Common_rust_": "Roya Común del Maíz",
  "Corn_(maize)___Northern_Leaf_Blight": "Tizón del Maíz",
  "Corn_(maize)___healthy": "Maíz Sano",
  Cutting_Weevil: "Gorgojo Cortador",
  Die_Back: "Muerte Regresiva",
  Gall_Midge: "Mosquita de las Agallas",
  "Grape___Black_rot": "Pudrición Negra de la Uva",
  "Grape___Esca_(Black_Measles)": "Esca de la Uva",
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)": "Tizón de la Hoja de la Uva",
  Grape___healthy: "Uva Sana",
  Healthy: "Planta Sana",
  "Orange___Haunglongbing_(Citrus_greening)": "HLB / Enverdecimiento de Cítricos",
  Peach___Bacterial_spot: "Mancha Bacteriana del Durazno",
  Peach___healthy: "Durazno Sano",
  "Pepper,_bell___Bacterial_spot": "Mancha Bacteriana del Pimiento",
  "Pepper,_bell___healthy": "Pimiento Sano",
  Potato___Early_blight: "Tizón Temprano de la Papa",
  Potato___Late_blight: "Tizón Tardío de la Papa",
  Potato___healthy: "Papa Sana",
  Powdery_Mildew: "Oídio",
  Raspberry___healthy: "Frambuesa Sana",
  Sooty_Mould: "Fumagina",
  Soybean___healthy: "Soja Sana",
  Squash___Powdery_mildew: "Oídio de la Calabaza",
  Strawberry___Leaf_scorch: "Quemadura de la Fresa",
  Strawberry___healthy: "Fresa Sana",
  Tomato___Bacterial_spot: "Mancha Bacteriana del Tomate",
  Tomato___Early_blight: "Tizón Temprano del Tomate",
  Tomato___Late_blight: "Tizón Tardío del Tomate",
  Tomato___Leaf_Mold: "Moho de la Hoja del Tomate",
  Tomato___Septoria_leaf_spot: "Septoriosis del Tomate",
  "Tomato___Spider_mites_Two-spotted_spider_mite": "Araña Roja del Tomate",
  Tomato___Target_Spot: "Mancha Diana del Tomate",
  Tomato___Tomato_Yellow_Leaf_Curl_Virus:
    "Virus del Rizado Amarillo del Tomate",
  Tomato___Tomato_mosaic_virus: "Virus del Mosaico del Tomate",
  Tomato___healthy: "Tomate Sano",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#D32F2F",
  high: "#E65100",
  moderate: "#F9A825",
  low: "#2E7D32",
  none: "#2E7D32",
  unknown: "#757575",
};

const SEVERITY_ES: Record<string, string> = {
  critical: "CRÍTICO",
  high: "ALTO",
  moderate: "MODERADO",
  low: "BAJO",
  none: "SANO",
  unknown: "DESCONOCIDO",
};

const diseases = (diseaseData as any).diseases || {};

interface DiagnosisResult {
  className: string;
  classNameEs: string;
  confidence: number;
  diseaseInfo: any;
  isHealthy: boolean;
}

function MainScreen() {
  const insets = useSafeAreaInsets();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [modelReady, setModelReady] = useState(false);

  const model = useTensorflowModel(
    require("./assets/models/agrovision_classifier.tflite")
  );

  useEffect(() => {
    if (model.state === "loaded") setModelReady(true);
  }, [model.state]);

  const pickImage = useCallback(async (fromCamera: boolean) => {
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso requerido", "Se necesita acceso para continuar.");
      return;
    }
    const fn = fromCamera
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;
    const result = await fn({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setDiagnosis(null);
    }
  }, []);

  const runDiagnosis = useCallback(async () => {
    if (!imageUri || model.state !== "loaded") return;
    setLoading(true);
    try {
      // 1. Resize image to 224x224 JPEG
      const resized = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ resize: { width: 224, height: 224 } }],
        { format: ImageManipulator.SaveFormat.JPEG, compress: 1.0 }
      );

      // 2. Read image as base64 and decode to raw pixels
      const b64 = await FileSystem.readAsStringAsync(resized.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Decode base64 → Uint8Array using atob (works in Hermes)
      const binaryStr = atob(b64);
      const jpegBytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        jpegBytes[i] = binaryStr.charCodeAt(i);
      }

      // Decode JPEG to raw RGBA pixels
      const decoded = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true });
      const pixels = decoded.data; // Uint8Array RGBA

      // 3. Convert RGBA → RGB float32 (0-255 range, model handles normalization)
      const inputData = new Float32Array(1 * 224 * 224 * 3);
      for (let i = 0; i < 224 * 224; i++) {
        inputData[i * 3 + 0] = pixels[i * 4 + 0]; // R
        inputData[i * 3 + 1] = pixels[i * 4 + 1]; // G
        inputData[i * 3 + 2] = pixels[i * 4 + 2]; // B
      }

      // 4. Run inference
      const output = model.model.runSync([inputData]);
      const probs = output[0] as Float32Array;

      let maxIdx = 0;
      let maxProb = 0;
      for (let i = 0; i < probs.length; i++) {
        if (probs[i] > maxProb) {
          maxProb = probs[i];
          maxIdx = i;
        }
      }
      const className = classifierMeta.classes[maxIdx];
      const diseaseKey = CLASS_TO_DISEASE[className] || "unknown";
      const diseaseInfo = diseases[diseaseKey] || {};
      const isHealthy =
        className.toLowerCase().includes("healthy") ||
        diseaseKey === "healthy";
      setDiagnosis({
        className,
        classNameEs: CLASS_NAMES_ES[className] || className.replace(/_/g, " "),
        confidence: maxProb,
        diseaseInfo,
        isHealthy,
      });
    } catch (err: any) {
      Alert.alert("Error", `No se pudo analizar la imagen: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [imageUri, model]);

  const severity = diagnosis?.diseaseInfo?.severity || "unknown";
  const sevColor = SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
  const sevLabel = SEVERITY_ES[severity] || severity;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.headerIcon}>🌿</Text>
        <View>
          <Text style={s.headerTitle}>AgroVisión</Text>
          <Text style={s.headerSub}>
            Detección de enfermedades en cultivos
          </Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.statusBar}>
          <View
            style={[
              s.statusDot,
              { backgroundColor: modelReady ? "#4CAF50" : "#FF9800" },
            ]}
          />
          <Text style={s.statusText}>
            {modelReady
              ? `Modelo listo — ${classifierMeta.num_classes} enfermedades`
              : "Cargando modelo..."}
          </Text>
          <Text style={[s.statusText, { textAlign: "right" }]}>
            SIN INTERNET
          </Text>
        </View>

        <View style={s.imageContainer}>
          {imageUri ? (
            <Image source={{ uri: imageUri }} style={s.image} />
          ) : (
            <View style={s.imagePlaceholder}>
              <Text style={s.placeholderIcon}>📷</Text>
              <Text style={s.placeholderText}>
                Tome una foto o seleccione de la galería
              </Text>
            </View>
          )}
        </View>

        <View style={s.buttonRow}>
          <Pressable
            style={[s.btn, s.btnCamera]}
            onPress={() => pickImage(true)}
          >
            <Text style={s.btnIcon}>📸</Text>
            <Text style={s.btnText}>Cámara</Text>
          </Pressable>
          <Pressable
            style={[s.btn, s.btnGallery]}
            onPress={() => pickImage(false)}
          >
            <Text style={s.btnIcon}>🖼️</Text>
            <Text style={s.btnText}>Galería</Text>
          </Pressable>
        </View>

        {imageUri && !diagnosis && (
          <Pressable
            style={[s.analyzeBtn, !modelReady && s.btnDisabled]}
            onPress={runDiagnosis}
            disabled={!modelReady || loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={s.analyzeBtnIcon}>🔬</Text>
                <Text style={s.analyzeBtnText}>Analizar Cultivo</Text>
              </>
            )}
          </Pressable>
        )}

        {diagnosis && (
          <View style={s.resultCard}>
            <View
              style={[
                s.resultHeader,
                {
                  backgroundColor: diagnosis.isHealthy ? "#1B5E20" : "#B71C1C",
                },
              ]}
            >
              <Text style={s.resultEmoji}>
                {diagnosis.isHealthy ? "✅" : "⚠️"}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={s.resultName}>{diagnosis.classNameEs}</Text>
                <Text style={s.resultConf}>
                  Confianza: {(diagnosis.confidence * 100).toFixed(1)}%
                </Text>
              </View>
            </View>

            {!diagnosis.isHealthy && (
              <>
                <View style={s.resultRow}>
                  <Text style={s.resultLabel}>Severidad</Text>
                  <View
                    style={[s.severityBadge, { backgroundColor: sevColor }]}
                  >
                    <Text style={s.severityText}>{sevLabel}</Text>
                  </View>
                </View>

                {diagnosis.diseaseInfo.scientific && (
                  <View style={s.resultRow}>
                    <Text style={s.resultLabel}>Nombre científico</Text>
                    <Text style={s.resultValue}>
                      {diagnosis.diseaseInfo.scientific}
                    </Text>
                  </View>
                )}

                {diagnosis.diseaseInfo.description && (
                  <View style={s.resultSection}>
                    <Text style={s.sectionTitle}>📋 Descripción</Text>
                    <Text style={s.sectionBody}>
                      {diagnosis.diseaseInfo.description}
                    </Text>
                  </View>
                )}

                {diagnosis.diseaseInfo.treatment && (
                  <View style={s.resultSection}>
                    <Text style={s.sectionTitle}>💊 Tratamiento</Text>
                    <Text style={s.sectionBody}>
                      {diagnosis.diseaseInfo.treatment}
                    </Text>
                  </View>
                )}

                {diagnosis.diseaseInfo.prevention && (
                  <View style={s.resultSection}>
                    <Text style={s.sectionTitle}>🛡️ Prevención</Text>
                    <Text style={s.sectionBody}>
                      {diagnosis.diseaseInfo.prevention}
                    </Text>
                  </View>
                )}
              </>
            )}

            {diagnosis.isHealthy && (
              <View style={s.resultSection}>
                <Text style={s.sectionBody}>
                  La planta se ve saludable. No se detectaron signos de
                  enfermedad. Continúe monitoreando regularmente.
                </Text>
              </View>
            )}

            <Pressable
              style={s.retryBtn}
              onPress={() => {
                setDiagnosis(null);
                setImageUri(null);
              }}
            >
              <Text style={s.retryText}>🔄 Nueva foto</Text>
            </Pressable>
          </View>
        )}

        <View style={s.footer}>
          <Text style={s.footerText}>
            AgroVisión Atlántico — Skyline Capital SAS
          </Text>
          <Text style={s.footerText}>
            Modelo: DINOv2 + ArcFace | Precisión:{" "}
            {classifierMeta.model_accuracy}%
          </Text>
          <Text style={s.footerText}>
            Análisis 100% local — sin conexión a internet
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F1F8E9" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: "#1B5E20",
    gap: 12,
  },
  headerIcon: { fontSize: 32 },
  headerTitle: { fontSize: 22, fontWeight: "800", color: "#fff" },
  headerSub: { fontSize: 12, color: "#A5D6A7", marginTop: 1 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    gap: 8,
    elevation: 1,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: "#555", flex: 1 },
  imageContainer: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#fff",
    elevation: 2,
    marginBottom: 16,
  },
  image: { width: "100%", height: "100%", resizeMode: "cover" },
  imagePlaceholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  placeholderIcon: { fontSize: 64 },
  placeholderText: {
    fontSize: 16,
    color: "#888",
    textAlign: "center",
    paddingHorizontal: 40,
  },
  buttonRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
    borderRadius: 12,
    gap: 8,
    elevation: 2,
  },
  btnCamera: { backgroundColor: "#2E7D32" },
  btnGallery: { backgroundColor: "#1565C0" },
  btnIcon: { fontSize: 20 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  analyzeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E65100",
    padding: 16,
    borderRadius: 12,
    gap: 8,
    marginBottom: 16,
    elevation: 3,
  },
  btnDisabled: { opacity: 0.5 },
  analyzeBtnIcon: { fontSize: 22 },
  analyzeBtnText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  resultCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    elevation: 3,
    marginBottom: 16,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
  resultEmoji: { fontSize: 36 },
  resultName: { fontSize: 20, fontWeight: "800", color: "#fff" },
  resultConf: {
    fontSize: 13,
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
  resultRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#E8F5E9",
  },
  resultLabel: { fontSize: 14, color: "#555", fontWeight: "600" },
  resultValue: { fontSize: 14, color: "#333", fontStyle: "italic" },
  severityBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  severityText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  resultSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#E8F5E9",
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1B5E20",
    marginBottom: 6,
  },
  sectionBody: { fontSize: 14, color: "#333", lineHeight: 20 },
  retryBtn: { alignItems: "center", padding: 14 },
  retryText: { fontSize: 16, color: "#1B5E20", fontWeight: "700" },
  footer: { alignItems: "center", paddingVertical: 20, gap: 4 },
  footerText: { fontSize: 11, color: "#888", textAlign: "center" },
});
