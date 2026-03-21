import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  Image,
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Alert,
  ScrollView,
  Animated,
  Modal,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useTensorflowModel } from "react-native-fast-tflite";
import * as jpeg from "jpeg-js";

import classifierMeta from "./assets/models/classifier_metadata.json";
import diseaseData from "./assets/models/disease_metadata.json";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

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
  Apple___Black_rot: "Pudrici\u00f3n Negra del Manzano",
  Apple___Cedar_apple_rust: "Roya del Manzano",
  Apple___healthy: "Manzano Sano",
  Bacterial_Canker: "Cancro Bacteriano",
  Blueberry___healthy: "Ar\u00e1ndano Sano",
  "Cherry_(including_sour)___Powdery_mildew": "O\u00eddio del Cerezo",
  "Cherry_(including_sour)___healthy": "Cerezo Sano",
  "Corn_(maize)___Cercospora_leaf_spot_Gray_leaf_spot": "Mancha Gris del Ma\u00edz",
  "Corn_(maize)___Common_rust_": "Roya Com\u00fan del Ma\u00edz",
  "Corn_(maize)___Northern_Leaf_Blight": "Tiz\u00f3n del Ma\u00edz",
  "Corn_(maize)___healthy": "Ma\u00edz Sano",
  Cutting_Weevil: "Gorgojo Cortador",
  Die_Back: "Muerte Regresiva",
  Gall_Midge: "Mosquita de las Agallas",
  "Grape___Black_rot": "Pudrici\u00f3n Negra de la Uva",
  "Grape___Esca_(Black_Measles)": "Esca de la Uva",
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)": "Tiz\u00f3n de la Hoja de la Uva",
  Grape___healthy: "Uva Sana",
  Healthy: "Planta Sana",
  "Orange___Haunglongbing_(Citrus_greening)": "HLB / Enverdecimiento de C\u00edtricos",
  Peach___Bacterial_spot: "Mancha Bacteriana del Durazno",
  Peach___healthy: "Durazno Sano",
  "Pepper,_bell___Bacterial_spot": "Mancha Bacteriana del Pimiento",
  "Pepper,_bell___healthy": "Pimiento Sano",
  Potato___Early_blight: "Tiz\u00f3n Temprano de la Papa",
  Potato___Late_blight: "Tiz\u00f3n Tard\u00edo de la Papa",
  Potato___healthy: "Papa Sana",
  Powdery_Mildew: "O\u00eddio",
  Raspberry___healthy: "Frambuesa Sana",
  Sooty_Mould: "Fumagina",
  Soybean___healthy: "Soja Sana",
  Squash___Powdery_mildew: "O\u00eddio de la Calabaza",
  Strawberry___Leaf_scorch: "Quemadura de la Fresa",
  Strawberry___healthy: "Fresa Sana",
  Tomato___Bacterial_spot: "Mancha Bacteriana del Tomate",
  Tomato___Early_blight: "Tiz\u00f3n Temprano del Tomate",
  Tomato___Late_blight: "Tiz\u00f3n Tard\u00edo del Tomate",
  Tomato___Leaf_Mold: "Moho de la Hoja del Tomate",
  Tomato___Septoria_leaf_spot: "Septoriosis del Tomate",
  "Tomato___Spider_mites_Two-spotted_spider_mite": "Ara\u00f1a Roja del Tomate",
  Tomato___Target_Spot: "Mancha Diana del Tomate",
  Tomato___Tomato_Yellow_Leaf_Curl_Virus: "Virus del Rizado Amarillo del Tomate",
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
  critical: "CR\u00cdTICO",
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

const PATCH_GRID = 16; // DINOv2 ViT-S/14: 224/14 = 16 patches per side
const LINE_LEN = 80;

/** Find the attention-weighted centroid in screen coordinates.
 *  Uses top-25% attention values only so the dot moves away from center. */
function attnCentroid(attnMap: Float32Array): { x: number; y: number } {
  // Find threshold at 75th percentile — only keep the hottest patches
  const sorted = Float32Array.from(attnMap).sort();
  const p75 = sorted[Math.floor(sorted.length * 0.75)];

  let sumW = 0, sumX = 0, sumY = 0;
  for (let row = 0; row < PATCH_GRID; row++) {
    for (let col = 0; col < PATCH_GRID; col++) {
      const w = attnMap[row * PATCH_GRID + col];
      if (w < p75) continue; // ignore low-attention patches
      const s = w * w; // square to sharpen peaks
      sumW += s;
      sumX += col * s;
      sumY += row * s;
    }
  }
  if (sumW < 1e-8) return { x: SCREEN_W * 0.5, y: SCREEN_H * 0.45 };
  // Map from 0..15 patch grid to screen coordinates
  const px = (sumX / sumW) / (PATCH_GRID - 1);
  const py = (sumY / sumW) / (PATCH_GRID - 1);
  // Clamp to keep annotation visible (avoid edges)
  const x = Math.max(60, Math.min(SCREEN_W - 60, px * SCREEN_W));
  const y = Math.max(120, Math.min(SCREEN_H - 200, py * SCREEN_H));
  return { x, y };
}

function MainScreen() {
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [dotPos, setDotPos] = useState({ x: SCREEN_W * 0.5, y: SCREEN_H * 0.45 });
  const [modelReady, setModelReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const model = useTensorflowModel(
    require("./assets/models/agrovision_classifier.tflite")
  );

  useEffect(() => {
    if (model.state === "loaded") setModelReady(true);
  }, [model.state]);

  useEffect(() => {
    if (diagnosis) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.5,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [diagnosis]);

  const runInference = useCallback(
    async (uri: string) => {
      if (model.state !== "loaded") return;
      setLoading(true);
      try {
        const resized = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: 224, height: 224 } }],
          { format: ImageManipulator.SaveFormat.JPEG, compress: 1.0 }
        );
        const b64 = await FileSystem.readAsStringAsync(resized.uri, {
          encoding: "base64",
        });
        const binaryStr = atob(b64);
        const jpegBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          jpegBytes[i] = binaryStr.charCodeAt(i);
        }
        const decoded = jpeg.decode(jpegBytes, {
          useTArray: true,
          formatAsRGBA: true,
        });
        const pixels = decoded.data;
        const inputData = new Float32Array(1 * 224 * 224 * 3);
        for (let i = 0; i < 224 * 224; i++) {
          inputData[i * 3 + 0] = pixels[i * 4 + 0];
          inputData[i * 3 + 1] = pixels[i * 4 + 1];
          inputData[i * 3 + 2] = pixels[i * 4 + 2];
        }
        if (!model.model) throw new Error("Model not loaded");
        const output = model.model.runSync([inputData]);

        // Debug: log output structure
        console.log("AV: outputs:", output.length,
          "shapes:", output.map((o: any) => o.length));

        // Determine which output is probs (length 46) vs attn (length 256)
        let probs: Float32Array;
        let attnMap: Float32Array | null = null;
        if (output.length >= 2) {
          if (output[0].length === 46) {
            probs = output[0] as Float32Array;
            attnMap = output[1] as Float32Array;
          } else if (output[1].length === 46) {
            probs = output[1] as Float32Array;
            attnMap = output[0] as Float32Array;
          } else {
            probs = output[0] as Float32Array;
          }
        } else {
          probs = output[0] as Float32Array;
        }
        console.log("AV: probs len:", probs.length, "attn:", attnMap?.length);

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

        // Position dot at attention centroid
        if (attnMap && attnMap.length === PATCH_GRID * PATCH_GRID) {
          setDotPos(attnCentroid(attnMap));
        } else {
          // Fallback: center of screen
          setDotPos({ x: SCREEN_W * 0.5, y: SCREEN_H * 0.45 });
        }

        setDiagnosis({
          className,
          classNameEs:
            CLASS_NAMES_ES[className] || className.replace(/_/g, " "),
          confidence: maxProb,
          diseaseInfo,
          isHealthy,
        });
      } catch (err: any) {
        Alert.alert("Error", `No se pudo analizar: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [model]
  );

  const captureAndAnalyze = useCallback(async () => {
    if (!cameraRef.current || !modelReady || loading) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        skipProcessing: true,
      });
      setCapturedUri(photo.uri);
      setDiagnosis(null);
      setShowDetail(false);
      await runInference(photo.uri);
    } catch (err: any) {
      Alert.alert("Error", `No se pudo capturar: ${err.message}`);
    }
  }, [modelReady, loading, runInference]);

  const pickFromGallery = useCallback(async () => {
    setMenuOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso requerido", "Se necesita acceso a la galer\u00eda.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setCapturedUri(result.assets[0].uri);
      setDiagnosis(null);
      setShowDetail(false);
      await runInference(result.assets[0].uri);
    }
  }, [runInference]);

  const resetScan = useCallback(() => {
    setCapturedUri(null);
    setDiagnosis(null);
    setShowDetail(false);
  }, []);

  // Permission screen
  if (!permission?.granted) {
    return (
      <View style={s.permScreen}>
        <StatusBar style="light" hidden />
        <Text style={s.permTitle}>{"AgroVisi\u00f3n"}</Text>
        <Text style={s.permSub}>
          {"Se necesita acceso a la c\u00e1mara para detectar enfermedades en cultivos"}
        </Text>
        <Pressable style={s.permBtn} onPress={requestPermission}>
          <Text style={s.permBtnText}>{"Activar C\u00e1mara"}</Text>
        </Pressable>
      </View>
    );
  }

  const severity = diagnosis?.diseaseInfo?.severity || "unknown";
  const sevColor = SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
  const sevLabel = SEVERITY_ES[severity] || severity;

  return (
    <View style={s.root}>
      {/* Hide system bars for full immersive */}
      <StatusBar style="light" hidden />

      {/* Camera / Captured image — full screen */}
      {capturedUri ? (
        <Image source={{ uri: capturedUri }} style={s.fullScreenBg} resizeMode="cover" />
      ) : (
        <CameraView ref={cameraRef} style={s.fullScreenBg} facing="back" />
      )}

      {/* Top overlay — just title + hamburger, no background bar */}
      <View style={s.topOverlay}>
        <Pressable
          style={s.hamburger}
          onPress={() => setMenuOpen(!menuOpen)}
        >
          <View style={s.hamburgerLine} />
          <View style={s.hamburgerLine} />
          <View style={s.hamburgerLine} />
        </Pressable>

        <Text style={s.title}>{"AgroVisi\u00f3n"}</Text>

        <View
          style={[
            s.statusDot,
            { backgroundColor: modelReady ? "#4CAF50" : "#FF9800" },
          ]}
        />
      </View>

      {/* Hamburger dropdown */}
      {menuOpen && (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setMenuOpen(false)}
          />
          <View style={s.menuDropdown}>
            <Pressable style={s.menuItem} onPress={pickFromGallery}>
              <Text style={s.menuItemText}>{"Abrir Galer\u00eda"}</Text>
            </Pressable>
            <Pressable
              style={[s.menuItem, { borderBottomWidth: 0 }]}
              onPress={() => {
                setMenuOpen(false);
                Alert.alert(
                  "AgroVisi\u00f3n",
                  `Modelo: DINOv2 + ArcFace\nPrecisi\u00f3n: ${classifierMeta.model_accuracy}%\nClases: ${classifierMeta.num_classes}\n\n100% offline \u2014 sin internet\n\nSkyline Capital SAS`
                );
              }}
            >
              <Text style={s.menuItemText}>Acerca de</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* Loading overlay */}
      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator color="#4CAF50" size="large" />
          <Text style={s.loadingText}>Analizando...</Text>
        </View>
      )}

      {/* AR Annotation — dot at attention centroid + line + label */}
      {diagnosis && capturedUri && !loading && (
        <View style={s.annotationContainer} pointerEvents="box-none">
          {/* Pulsing outer ring at attention hotspot */}
          <Animated.View
            style={[
              s.annotRing,
              {
                top: dotPos.y - 18,
                left: dotPos.x - 18,
                borderColor: diagnosis.isHealthy ? "#4CAF50" : "#FF1744",
                transform: [{ scale: pulseAnim }],
              },
            ]}
          />
          {/* Solid dot */}
          <View
            style={[
              s.annotDot,
              {
                top: dotPos.y - 6,
                left: dotPos.x - 6,
                backgroundColor: diagnosis.isHealthy ? "#4CAF50" : "#FF1744",
              },
            ]}
          />

          {/* Line from dot going up */}
          <View
            style={[
              s.annotLine,
              {
                top: dotPos.y - LINE_LEN + 10,
                left: dotPos.x,
                height: LINE_LEN,
                backgroundColor: "#fff",
              },
            ]}
          />

          {/* Disease label — centered above line */}
          <Pressable
            style={[
              s.annotLabel,
              {
                top: dotPos.y - LINE_LEN - 50,
                left: Math.max(10, Math.min(SCREEN_W - 210, dotPos.x - 100)),
                backgroundColor: diagnosis.isHealthy
                  ? "rgba(46,125,50,0.92)"
                  : "rgba(183,28,28,0.92)",
              },
            ]}
            onPress={() => setShowDetail(true)}
          >
            <Text style={s.annotLabelName}>{diagnosis.classNameEs}</Text>
            <View style={s.annotLabelRow}>
              <Text style={s.annotConfText}>
                {(diagnosis.confidence * 100).toFixed(1)}%
              </Text>
              {!diagnosis.isHealthy && (
                <View style={[s.annotSevBadge, { backgroundColor: sevColor }]}>
                  <Text style={s.annotSevText}>{sevLabel}</Text>
                </View>
              )}
            </View>
          </Pressable>
        </View>
      )}

      {/* Bottom — capture or reset */}
      <View style={s.bottomBar}>
        {capturedUri ? (
          <Pressable style={s.resetBtn} onPress={resetScan}>
            <Text style={s.resetBtnText}>Nueva Foto</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[s.captureBtn, (!modelReady || loading) && { opacity: 0.4 }]}
            onPress={captureAndAnalyze}
            disabled={!modelReady || loading}
          >
            <View style={s.captureBtnInner} />
          </Pressable>
        )}
      </View>

      {/* Detail modal */}
      <Modal
        visible={showDetail && !!diagnosis}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setShowDetail(false)}
      >
        <Pressable
          style={s.modalBackdrop}
          onPress={() => setShowDetail(false)}
        >
          <Pressable style={s.modalCard} onPress={() => {}}>
            {diagnosis && (
              <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
                <View
                  style={[
                    s.modalHeader,
                    {
                      backgroundColor: diagnosis.isHealthy
                        ? "#1B5E20"
                        : "#B71C1C",
                    },
                  ]}
                >
                  <View style={s.modalDragBar} />
                  <Text style={s.modalTitle}>{diagnosis.classNameEs}</Text>
                  <Text style={s.modalConf}>
                    {"Confianza: " + (diagnosis.confidence * 100).toFixed(1) + "%"}
                  </Text>
                </View>

                {diagnosis.isHealthy ? (
                  <View style={s.modalSection}>
                    <Text style={s.modalBody}>
                      {"La planta se ve saludable. No se detectaron signos de enfermedad. Contin\u00fae monitoreando regularmente."}
                    </Text>
                  </View>
                ) : (
                  <>
                    <View style={s.modalRow}>
                      <Text style={s.modalLabel}>Severidad</Text>
                      <View
                        style={[s.modalSevBadge, { backgroundColor: sevColor }]}
                      >
                        <Text style={s.modalSevText}>{sevLabel}</Text>
                      </View>
                    </View>

                    {diagnosis.diseaseInfo.scientific && (
                      <View style={s.modalRow}>
                        <Text style={s.modalLabel}>{"Nombre cient\u00edfico"}</Text>
                        <Text style={s.modalValue}>
                          {diagnosis.diseaseInfo.scientific}
                        </Text>
                      </View>
                    )}

                    {diagnosis.diseaseInfo.description && (
                      <View style={s.modalSection}>
                        <Text style={s.modalSectionTitle}>{"Descripci\u00f3n"}</Text>
                        <Text style={s.modalBody}>
                          {diagnosis.diseaseInfo.description}
                        </Text>
                      </View>
                    )}

                    {diagnosis.diseaseInfo.treatment && (
                      <View style={s.modalSection}>
                        <Text style={s.modalSectionTitle}>Tratamiento</Text>
                        <Text style={s.modalBody}>
                          {diagnosis.diseaseInfo.treatment}
                        </Text>
                      </View>
                    )}

                    {diagnosis.diseaseInfo.prevention && (
                      <View style={s.modalSection}>
                        <Text style={s.modalSectionTitle}>{"Prevenci\u00f3n"}</Text>
                        <Text style={s.modalBody}>
                          {diagnosis.diseaseInfo.prevention}
                        </Text>
                      </View>
                    )}
                  </>
                )}

                <Pressable
                  style={s.modalClose}
                  onPress={() => setShowDetail(false)}
                >
                  <Text style={s.modalCloseText}>Cerrar</Text>
                </Pressable>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
  root: { flex: 1, backgroundColor: "#000" },
  fullScreenBg: {
    ...StyleSheet.absoluteFillObject,
    width: SCREEN_W,
    height: SCREEN_H,
  },

  // Permission screen
  permScreen: {
    flex: 1,
    backgroundColor: "#1B5E20",
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    gap: 16,
  },
  permTitle: { fontSize: 32, fontWeight: "900", color: "#fff" },
  permSub: {
    fontSize: 16,
    color: "#A5D6A7",
    textAlign: "center",
    lineHeight: 24,
  },
  permBtn: {
    backgroundColor: "#fff",
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 30,
    marginTop: 20,
  },
  permBtnText: { color: "#1B5E20", fontSize: 18, fontWeight: "800" },

  // Top overlay — floating, no background bar
  topOverlay: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    zIndex: 10,
  },
  hamburger: {
    width: 40,
    height: 40,
    justifyContent: "center",
    gap: 5,
  },
  hamburgerLine: {
    width: 26,
    height: 3,
    backgroundColor: "#fff",
    borderRadius: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
    elevation: 5,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 24,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: 1.5,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  statusDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.8)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    elevation: 5,
  },

  // Hamburger menu
  menuDropdown: {
    position: "absolute",
    top: 55,
    left: 16,
    backgroundColor: "rgba(0,0,0,0.88)",
    borderRadius: 12,
    overflow: "hidden",
    zIndex: 30,
    minWidth: 200,
    elevation: 10,
  },
  menuItem: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  menuItemText: { color: "#fff", fontSize: 17, fontWeight: "600" },

  // Loading
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    zIndex: 15,
    gap: 12,
  },
  loadingText: { color: "#fff", fontSize: 18, fontWeight: "700" },

  // AR Annotation
  annotationContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 8,
  },
  annotRing: {
    position: "absolute",
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    opacity: 0.5,
  },
  annotDot: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    elevation: 5,
  },
  annotLine: {
    position: "absolute",
    width: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
    elevation: 3,
  },
  annotLabel: {
    position: "absolute",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    minWidth: 200,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  annotLabelName: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
  },
  annotLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  annotConfText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 14,
    fontWeight: "600",
  },
  annotSevBadge: {
    paddingVertical: 2,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  annotSevText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
  },

  // Bottom bar
  bottomBar: {
    position: "absolute",
    bottom: 30,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
  },
  captureBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 5,
    borderColor: "rgba(255,255,255,0.9)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  captureBtnInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#4CAF50",
  },
  resetBtn: {
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.7)",
  },
  resetBtnText: { color: "#fff", fontSize: 18, fontWeight: "700" },

  // Detail modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_H * 0.7,
    overflow: "hidden",
  },
  modalDragBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.4)",
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  modalHeader: { padding: 20, paddingTop: 8 },
  modalTitle: { fontSize: 22, fontWeight: "900", color: "#fff" },
  modalConf: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
    marginTop: 4,
  },
  modalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E8F5E9",
  },
  modalLabel: { fontSize: 15, color: "#555", fontWeight: "600" },
  modalValue: { fontSize: 15, color: "#333", fontStyle: "italic" },
  modalSevBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
  },
  modalSevText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  modalSection: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#E8F5E9",
  },
  modalSectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1B5E20",
    marginBottom: 8,
  },
  modalBody: { fontSize: 15, color: "#333", lineHeight: 22 },
  modalClose: { alignItems: "center", paddingVertical: 18 },
  modalCloseText: { fontSize: 17, color: "#1B5E20", fontWeight: "700" },
});
