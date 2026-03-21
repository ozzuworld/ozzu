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
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
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
  "Corn_(maize)___Cercospora_leaf_spot_Gray_leaf_spot":
    "Mancha Gris del Ma\u00edz",
  "Corn_(maize)___Common_rust_": "Roya Com\u00fan del Ma\u00edz",
  "Corn_(maize)___Northern_Leaf_Blight": "Tiz\u00f3n del Ma\u00edz",
  "Corn_(maize)___healthy": "Ma\u00edz Sano",
  Cutting_Weevil: "Gorgojo Cortador",
  Die_Back: "Muerte Regresiva",
  Gall_Midge: "Mosquita de las Agallas",
  "Grape___Black_rot": "Pudrici\u00f3n Negra de la Uva",
  "Grape___Esca_(Black_Measles)": "Esca de la Uva",
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)":
    "Tiz\u00f3n de la Hoja de la Uva",
  Grape___healthy: "Uva Sana",
  Healthy: "Planta Sana",
  "Orange___Haunglongbing_(Citrus_greening)":
    "HLB / Enverdecimiento de C\u00edtricos",
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

function MainScreen() {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
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

  // Pulse animation for the annotation dot
  useEffect(() => {
    if (diagnosis) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.4,
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

  // Permission not granted yet
  if (!permission?.granted) {
    return (
      <View style={[s.permScreen, { paddingTop: insets.top + 40 }]}>
        <StatusBar style="light" />
        <Text style={s.permIcon}>🌿</Text>
        <Text style={s.permTitle}>AgroVisi\u00f3n</Text>
        <Text style={s.permSub}>
          Se necesita acceso a la c\u00e1mara para detectar enfermedades en
          cultivos
        </Text>
        <Pressable style={s.permBtn} onPress={requestPermission}>
          <Text style={s.permBtnText}>Activar C\u00e1mara</Text>
        </Pressable>
      </View>
    );
  }

  const severity = diagnosis?.diseaseInfo?.severity || "unknown";
  const sevColor = SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
  const sevLabel = SEVERITY_ES[severity] || severity;

  return (
    <View style={s.root}>
      <StatusBar style="light" />

      {/* Camera / Captured image — full screen background */}
      {capturedUri ? (
        <Image source={{ uri: capturedUri }} style={s.fullScreenBg} />
      ) : (
        <CameraView ref={cameraRef} style={s.fullScreenBg} facing="back" />
      )}

      {/* Dark gradient overlay at top */}
      <View style={[s.topGradient, { paddingTop: insets.top + 8 }]}>
        {/* Hamburger menu */}
        <Pressable
          style={s.hamburger}
          onPress={() => setMenuOpen(!menuOpen)}
        >
          <View style={s.hamburgerLine} />
          <View style={s.hamburgerLine} />
          <View style={s.hamburgerLine} />
        </Pressable>

        {/* Title */}
        <Text style={s.title}>AgroVisi\u00f3n</Text>

        {/* Model status indicator */}
        <View
          style={[
            s.statusDot,
            { backgroundColor: modelReady ? "#4CAF50" : "#FF9800" },
          ]}
        />
      </View>

      {/* Hamburger menu dropdown */}
      {menuOpen && (
        <View style={[s.menuDropdown, { top: insets.top + 56 }]}>
          <Pressable style={s.menuItem} onPress={pickFromGallery}>
            <Text style={s.menuItemText}>Abrir Galer\u00eda</Text>
          </Pressable>
          <Pressable
            style={s.menuItem}
            onPress={() => {
              setMenuOpen(false);
              Alert.alert(
                "AgroVisi\u00f3n",
                `Modelo: DINOv2 + ArcFace\nPrecisi\u00f3n: ${classifierMeta.model_accuracy}%\nClases: ${classifierMeta.num_classes}\n\n100% offline — sin internet\n\nSkyline Capital SAS`
              );
            }}
          >
            <Text style={s.menuItemText}>Acerca de</Text>
          </Pressable>
        </View>
      )}

      {/* Scanning crosshair (when camera is live) */}
      {!capturedUri && !loading && (
        <View style={s.crosshairContainer}>
          <View style={s.crosshairBox}>
            <View style={[s.corner, s.cornerTL]} />
            <View style={[s.corner, s.cornerTR]} />
            <View style={[s.corner, s.cornerBL]} />
            <View style={[s.corner, s.cornerBR]} />
          </View>
          <Text style={s.crosshairText}>Apunte hacia la planta</Text>
        </View>
      )}

      {/* Loading spinner overlay */}
      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator color="#4CAF50" size="large" />
          <Text style={s.loadingText}>Analizando...</Text>
        </View>
      )}

      {/* AR Annotation — dot + line + label */}
      {diagnosis && capturedUri && !loading && (
        <View style={s.annotationContainer} pointerEvents="box-none">
          {/* Pulsing dot at center of image */}
          <Animated.View
            style={[
              s.annotDot,
              {
                backgroundColor: diagnosis.isHealthy ? "#4CAF50" : "#FF1744",
                transform: [{ scale: pulseAnim }],
              },
            ]}
          />
          <View
            style={[
              s.annotDotInner,
              {
                backgroundColor: diagnosis.isHealthy ? "#fff" : "#fff",
              },
            ]}
          />

          {/* Line from dot going right-up */}
          <View style={s.annotLine} />

          {/* Disease label at end of line */}
          <Pressable
            style={[
              s.annotLabel,
              {
                backgroundColor: diagnosis.isHealthy
                  ? "rgba(46,125,50,0.92)"
                  : "rgba(183,28,28,0.92)",
              },
            ]}
            onPress={() => setShowDetail(true)}
          >
            <Text style={s.annotLabelText}>{diagnosis.classNameEs}</Text>
            <Text style={s.annotConfText}>
              {(diagnosis.confidence * 100).toFixed(1)}%
            </Text>
          </Pressable>

          {/* Severity badge below label */}
          {!diagnosis.isHealthy && (
            <View style={[s.annotSeverity, { backgroundColor: sevColor }]}>
              <Text style={s.annotSeverityText}>{sevLabel}</Text>
            </View>
          )}

          {/* Tap hint */}
          <Pressable style={s.tapHint} onPress={() => setShowDetail(true)}>
            <Text style={s.tapHintText}>Toca para ver detalles</Text>
          </Pressable>
        </View>
      )}

      {/* Bottom controls */}
      <View style={[s.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
        {capturedUri ? (
          /* After capture: reset button */
          <Pressable style={s.resetBtn} onPress={resetScan}>
            <Text style={s.resetBtnText}>Nueva Foto</Text>
          </Pressable>
        ) : (
          /* Live camera: capture button */
          <Pressable
            style={[s.captureBtn, (!modelReady || loading) && s.captureBtnDisabled]}
            onPress={captureAndAnalyze}
            disabled={!modelReady || loading}
          >
            <View style={s.captureBtnInner} />
          </Pressable>
        )}
      </View>

      {/* Detail popup modal */}
      <Modal
        visible={showDetail && !!diagnosis}
        animationType="slide"
        transparent
        onRequestClose={() => setShowDetail(false)}
      >
        <Pressable
          style={s.modalBackdrop}
          onPress={() => setShowDetail(false)}
        >
          <Pressable style={s.modalCard} onPress={() => {}}>
            {diagnosis && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                {/* Header */}
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
                    Confianza: {(diagnosis.confidence * 100).toFixed(1)}%
                  </Text>
                </View>

                {diagnosis.isHealthy ? (
                  <View style={s.modalSection}>
                    <Text style={s.modalBody}>
                      La planta se ve saludable. No se detectaron signos de
                      enfermedad. Contin\u00fae monitoreando regularmente.
                    </Text>
                  </View>
                ) : (
                  <>
                    {/* Severity */}
                    <View style={s.modalRow}>
                      <Text style={s.modalLabel}>Severidad</Text>
                      <View
                        style={[
                          s.modalSevBadge,
                          { backgroundColor: sevColor },
                        ]}
                      >
                        <Text style={s.modalSevText}>{sevLabel}</Text>
                      </View>
                    </View>

                    {diagnosis.diseaseInfo.scientific && (
                      <View style={s.modalRow}>
                        <Text style={s.modalLabel}>Nombre cient\u00edfico</Text>
                        <Text style={s.modalValue}>
                          {diagnosis.diseaseInfo.scientific}
                        </Text>
                      </View>
                    )}

                    {diagnosis.diseaseInfo.description && (
                      <View style={s.modalSection}>
                        <Text style={s.modalSectionTitle}>Descripci\u00f3n</Text>
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
                        <Text style={s.modalSectionTitle}>Prevenci\u00f3n</Text>
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
  permIcon: { fontSize: 80 },
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

  // Top bar
  topGradient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
    zIndex: 10,
  },
  hamburger: {
    width: 36,
    height: 36,
    justifyContent: "center",
    gap: 5,
  },
  hamburgerLine: {
    width: 24,
    height: 2.5,
    backgroundColor: "#fff",
    borderRadius: 2,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 22,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: 1,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#fff",
  },

  // Hamburger menu
  menuDropdown: {
    position: "absolute",
    left: 16,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 12,
    overflow: "hidden",
    zIndex: 20,
    minWidth: 180,
  },
  menuItem: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  menuItemText: { color: "#fff", fontSize: 16, fontWeight: "600" },

  // Crosshair
  crosshairContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 5,
  },
  crosshairBox: {
    width: SCREEN_W * 0.65,
    height: SCREEN_W * 0.65,
  },
  corner: {
    position: "absolute",
    width: 30,
    height: 30,
    borderColor: "#4CAF50",
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
  },
  crosshairText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    marginTop: 16,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Loading
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    zIndex: 15,
    gap: 12,
  },
  loadingText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },

  // AR Annotation
  annotationContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 8,
  },
  annotDot: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 12,
    left: SCREEN_W * 0.35 - 12,
    width: 24,
    height: 24,
    borderRadius: 12,
    opacity: 0.6,
  },
  annotDotInner: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 5,
    left: SCREEN_W * 0.35 - 5,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  annotLine: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 50,
    left: SCREEN_W * 0.35,
    width: SCREEN_W * 0.3,
    height: 2,
    backgroundColor: "#fff",
    transform: [{ rotate: "-30deg" }],
    transformOrigin: "left center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
  },
  annotLabel: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 100,
    left: SCREEN_W * 0.5,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    maxWidth: SCREEN_W * 0.48,
  },
  annotLabelText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
  },
  annotConfText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    marginTop: 2,
  },
  annotSeverity: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 55,
    left: SCREEN_W * 0.5,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  annotSeverityText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
  },
  tapHint: {
    position: "absolute",
    top: SCREEN_H * 0.4 - 28,
    left: SCREEN_W * 0.5,
  },
  tapHintText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontStyle: "italic",
  },

  // Bottom bar
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingTop: 16,
    backgroundColor: "rgba(0,0,0,0.35)",
    zIndex: 10,
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtnDisabled: { opacity: 0.4 },
  captureBtnInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "#4CAF50",
  },
  resetBtn: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: "#fff",
  },
  resetBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },

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
  modalHeader: {
    padding: 20,
    paddingTop: 8,
  },
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
  modalClose: {
    alignItems: "center",
    paddingVertical: 18,
  },
  modalCloseText: { fontSize: 17, color: "#1B5E20", fontWeight: "700" },
});
