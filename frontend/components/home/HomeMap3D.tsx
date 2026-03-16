// HomeMap3D.tsx — Fullscreen interactive 3D apartment with device markers
// Touch: drag to rotate, pinch to zoom, two-finger pan
// Edit mode: long-press to place items, drag to reposition
import { Suspense, useRef, useMemo, useEffect, useState, useCallback } from "react";
import { View, Text, PanResponder, Pressable, Modal, ScrollView, Platform, Dimensions } from "react-native";
import { Canvas, useFrame, useThree } from "@react-three/fiber/native";
import * as THREE from "three";
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import roomData from "../../assets/home-map/rooms.json";

// ── Types ──
interface PositionData {
  room: string;
  confidence: number;
  method: string;
  x?: number;
  z?: number;
  furniture?: string;
}

export interface DeviceMarker {
  id: string;
  name: string;
  icon: string;
  entityId: string;
  domain: string;
  position: [number, number]; // [x, z] in floor plan coords
  color: string;
  room: string;
}

interface Props {
  position?: PositionData | null;
  activeRoom?: string | null;
  deviceStates?: Record<string, { state: string; attributes?: any }>;
  onDeviceTap?: (device: DeviceMarker) => void;
  onDeviceToggle?: (entityId: string, domain: string) => void;
  // Edit mode
  editMode?: boolean;
  placedDevices?: DeviceMarker[];
  onPlaceDevice?: (device: DeviceMarker) => void;
  onMoveDevice?: (deviceId: string, newPos: [number, number]) => void;
  onRemoveDevice?: (deviceId: string) => void;
  onRequestPlaceAt?: (worldX: number, worldZ: number) => void;
}

// ── All available devices that can be placed ──
export const ALL_DEVICES: Omit<DeviceMarker, "position">[] = [
  { id: "main_tv", name: "Main TV", icon: "📺", entityId: "media_player.main_tv", domain: "media_player", color: "#CE93D8", room: "living" },
  { id: "spotify", name: "Spotify", icon: "🎵", entityId: "media_player.spotify_king_kazuma", domain: "media_player", color: "#1DB954", room: "living" },
  { id: "ac", name: "AC", icon: "❄️", entityId: "climate.living_room_ac", domain: "climate", color: "#4FC3F7", room: "living" },
  { id: "midea_washer", name: "Washer", icon: "🫧", entityId: "switch.151732606804847_power", domain: "switch", color: "#3B82F6", room: "kitchen" },
  { id: "living_room_cam", name: "LR Camera", icon: "📹", entityId: "switch.living_room_cam_power", domain: "switch", color: "#F59E0B", room: "living" },
  { id: "security_cam", name: "Security Cam", icon: "📹", entityId: "switch.cam1_power", domain: "switch", color: "#EF4444", room: "security" },
  { id: "sous_vide", name: "Sous Vide", icon: "🍳", entityId: "switch.s_vide_switch", domain: "switch", color: "#F97316", room: "kitchen" },
  { id: "dusk_vader", name: "Dusk Vader", icon: "🤖", entityId: "vacuum.dusk_vader", domain: "vacuum", color: "#8B5CF6", room: "cleaning" },
  { id: "node_1", name: "ESP32 Node 1", icon: "📡", entityId: "_node_1", domain: "sensor", color: "#EF4444", room: "living" },
  { id: "node_2", name: "ESP32 Node 2", icon: "📡", entityId: "_node_2", domain: "sensor", color: "#EF4444", room: "master" },
  { id: "node_3", name: "ESP32 Node 3", icon: "📡", entityId: "_node_3", domain: "sensor", color: "#EF4444", room: "office" },
];

// ── Camera state ──
interface CameraState {
  theta: number;
  phi: number;
  radius: number;
  targetX: number;
  targetZ: number;
}

// ── GLB Model ──
function ApartmentModel({ activeRoom }: { activeRoom?: string | null }) {
  const [model, setModel] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadModel() {
      try {
        const asset = Asset.fromModule(require("../../assets/home-map/apartment.glb"));
        await asset.downloadAsync();
        const uri = asset.localUri || asset.uri;
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const binary = atob(base64);
        const buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        const loader = new GLTFLoader();
        loader.parse(buffer, "", (gltf) => { if (!cancelled) setModel(gltf.scene); });
      } catch (err) {
        console.warn("Failed to load GLB:", err);
      }
    }
    loadModel();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!model) return;
    model.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = child.material as THREE.MeshStandardMaterial;
        mat.color.set("#d4d4d8");
        mat.transparent = true;
        mat.opacity = 0.85;
        mat.roughness = 0.8;
        mat.metalness = 0.05;
      }
    });
    if (activeRoom) {
      const room = roomData.rooms.find((r) => r.id === activeRoom);
      if (room) {
        const floorMesh = model.getObjectByName(room.floor_mesh);
        if (floorMesh instanceof THREE.Mesh && floorMesh.material) {
          const mat = floorMesh.material as THREE.MeshStandardMaterial;
          mat.color.set(room.color);
          mat.opacity = 0.6;
        }
        const shadowIdx = parseInt(room.floor_mesh.replace("GLTF_", "")) + 1;
        const shadowMesh = model.getObjectByName(`GLTF_${shadowIdx}`);
        if (shadowMesh instanceof THREE.Mesh && shadowMesh.material) {
          const mat = shadowMesh.material as THREE.MeshStandardMaterial;
          mat.color.set(room.color);
          mat.opacity = 0.4;
        }
      }
    }
  }, [model, activeRoom]);

  if (!model) return null;
  return <primitive object={model} />;
}

// ── Device Marker 3D ──
function DeviceMarker3D({
  device,
  isOn,
  onTap,
  editMode,
}: {
  device: DeviceMarker;
  isOn: boolean;
  onTap: () => void;
  editMode?: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    if (editMode) {
      // Bounce animation in edit mode
      const t = clock.getElapsedTime();
      meshRef.current.position.y = -1.10 + Math.sin(t * 4 + device.position[0] * 2) * 0.06;
      if (glowRef.current) {
        (glowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.35;
        glowRef.current.scale.setScalar(1.2 + Math.sin(t * 3) * 0.2);
      }
    } else if (isOn) {
      const t = clock.getElapsedTime();
      meshRef.current.position.y = -1.15 + Math.sin(t * 2 + device.position[0]) * 0.04;
      if (glowRef.current) {
        const pulse = 0.8 + Math.sin(t * 3) * 0.2;
        (glowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.25 * pulse;
        glowRef.current.scale.setScalar(1 + Math.sin(t * 2) * 0.15);
      }
    } else {
      meshRef.current.position.y = -1.20;
      if (glowRef.current) {
        (glowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.08;
      }
    }
  });

  return (
    <group position={[device.position[0], 0, device.position[1]]}>
      <mesh
        ref={meshRef}
        position={[0, -1.20, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTap();
        }}
      >
        <sphereGeometry args={[isOn || editMode ? 0.16 : 0.12, 16, 16]} />
        <meshBasicMaterial
          color={editMode ? "#06B6D4" : (isOn ? device.color : "#525252")}
          transparent
          opacity={isOn || editMode ? 0.95 : 0.5}
        />
      </mesh>
      <mesh
        ref={glowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -1.54, 0]}
      >
        <circleGeometry args={[0.3, 24]} />
        <meshBasicMaterial
          color={editMode ? "#06B6D4" : device.color}
          transparent
          opacity={isOn ? 0.25 : 0.08}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, -1.37, 0]}>
        <cylinderGeometry args={[0.008, 0.008, 0.34, 4]} />
        <meshBasicMaterial
          color={editMode ? "#06B6D4" : device.color}
          transparent
          opacity={isOn || editMode ? 0.4 : 0.15}
        />
      </mesh>
    </group>
  );
}

// ── Position Beacon ──
function PositionBeacon({ position }: { position: PositionData }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const pillarRef = useRef<THREE.Mesh>(null);

  const pos = useMemo(() => {
    if (position.x != null && position.z != null) {
      return new THREE.Vector3(position.x, 0, position.z);
    }
    const room = roomData.rooms.find((r) => r.id === position.room);
    if (room) return new THREE.Vector3(room.center[0], 0, room.center[1]);
    return new THREE.Vector3(0, 0, 0);
  }, [position]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (meshRef.current) {
      // Pulsing scale
      const pulse = 1.0 + Math.sin(t * 3) * 0.2;
      meshRef.current.scale.setScalar(pulse);
      // Gentle hover
      meshRef.current.position.y = 0.5 + Math.sin(t * 2) * 0.1;
    }
    if (ringRef.current) {
      const expand = (t % 2) / 2;
      ringRef.current.scale.setScalar(1 + expand * 4);
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - expand);
    }
  });

  const color = position.method?.includes("ble") ? "#22C55E" : "#06B6D4";

  return (
    <group position={pos}>
      {/* Vertical pillar — always visible */}
      <mesh ref={pillarRef} position={[0, -0.5, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 2.0, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} depthTest={false} />
      </mesh>
      {/* Main beacon sphere — large, above everything, no depth test */}
      <mesh ref={meshRef} position={[0, 0.5, 0]} renderOrder={999}>
        <sphereGeometry args={[0.3, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      {/* Outer glow sphere */}
      <mesh position={[0, 0.5, 0]} renderOrder={998}>
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} depthTest={false} />
      </mesh>
      {/* Pulsing ring at floor level */}
      <mesh ref={ringRef} position={[0, -1.5, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={997}>
        <ringGeometry args={[0.3, 0.45, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} side={THREE.DoubleSide} depthTest={false} />
      </mesh>
    </group>
  );
}

// ── Edit Mode Drop Target — invisible plane for raycasting ──
function DropPlane({ onDrop }: { onDrop: (x: number, z: number) => void }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -1.54, 0]}
      onPointerDown={(e) => {
        e.stopPropagation();
        onDrop(e.point.x, e.point.z);
      }}
    >
      <planeGeometry args={[20, 20]} />
      <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ── Camera Controller ──
function CameraController({ stateRef }: { stateRef: React.MutableRefObject<CameraState> }) {
  const { camera } = useThree();
  useFrame(() => {
    const s = stateRef.current;
    const x = s.targetX + s.radius * Math.sin(s.phi) * Math.cos(s.theta);
    const y = s.radius * Math.cos(s.phi);
    const z = s.targetZ + s.radius * Math.sin(s.phi) * Math.sin(s.theta);
    camera.position.set(x, y, z);
    camera.lookAt(s.targetX, -1, s.targetZ);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 30;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

// ── Lighting ──
function Lighting() {
  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[8, 12, 5]} intensity={0.8} />
      <directionalLight position={[-5, 8, -3]} intensity={0.3} />
    </>
  );
}

// ── Device Popup ──
function DevicePopup({
  device,
  state,
  visible,
  onClose,
  onToggle,
  editMode,
  onRemove,
}: {
  device: DeviceMarker | null;
  state?: { state: string; attributes?: any };
  visible: boolean;
  onClose: () => void;
  onToggle: () => void;
  editMode?: boolean;
  onRemove?: () => void;
}) {
  if (!device) return null;

  const entityState = state?.state ?? "unavailable";
  const isOn = ["on", "playing", "cool", "heat", "auto", "cleaning", "returning"].includes(entityState);
  const isUnavailable = entityState === "unavailable";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1 }} onPress={onClose}>
        <View style={{ flex: 1, justifyContent: "flex-end", paddingBottom: 100 }}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              marginHorizontal: 24,
              backgroundColor: "rgba(20,20,20,0.95)",
              borderRadius: 20,
              borderWidth: 1,
              borderColor: editMode ? "rgba(6,182,212,0.4)" : (isOn ? `${device.color}40` : "rgba(255,255,255,0.1)"),
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                padding: 16,
                gap: 12,
                borderBottomWidth: 1,
                borderColor: "rgba(255,255,255,0.06)",
              }}
            >
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: isOn ? `${device.color}25` : "rgba(255,255,255,0.06)",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 20 }}>{device.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#FFF", fontSize: 16, fontWeight: "600" }}>
                  {device.name}
                </Text>
                <Text style={{ color: isOn ? device.color : "rgba(255,255,255,0.4)", fontSize: 12 }}>
                  {editMode ? `Position: (${device.position[0].toFixed(1)}, ${device.position[1].toFixed(1)})` : (isUnavailable ? "Offline" : entityState)}
                </Text>
              </View>
              {!editMode && (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: isOn ? device.color : "rgba(255,255,255,0.15)",
                    ...(isOn && Platform.OS === "ios" ? {
                      shadowColor: device.color,
                      shadowRadius: 6,
                      shadowOpacity: 0.6,
                      shadowOffset: { width: 0, height: 0 },
                    } : {}),
                  }}
                />
              )}
            </View>

            {/* AC temperature display */}
            {!editMode && device.domain === "climate" && state?.attributes?.current_temperature && (
              <View style={{ padding: 16, alignItems: "center" }}>
                <Text
                  style={{
                    color: isOn ? device.color : "rgba(255,255,255,0.3)",
                    fontSize: 48,
                    fontWeight: "200",
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  }}
                >
                  {Math.round(state.attributes.current_temperature)}{"\u00B0"}
                </Text>
                {state.attributes.temperature && (
                  <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>
                    Target: {state.attributes.temperature}{"\u00B0"}
                  </Text>
                )}
              </View>
            )}

            {/* Vacuum info */}
            {!editMode && device.domain === "vacuum" && (
              <View style={{ padding: 16, gap: 8 }}>
                {state?.attributes?.battery_level != null && (
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>Battery</Text>
                    <Text style={{ color: "#FFF", fontSize: 12, fontWeight: "600" }}>
                      {state.attributes.battery_level}%
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Action buttons */}
            <View style={{ padding: 16, gap: 8 }}>
              {!editMode && !isUnavailable && (
                <Pressable
                  onPress={onToggle}
                  style={({ pressed }) => ({
                    backgroundColor: isOn ? `${device.color}20` : "rgba(255,255,255,0.08)",
                    borderWidth: 1,
                    borderColor: isOn ? `${device.color}40` : "rgba(255,255,255,0.12)",
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ color: isOn ? device.color : "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: "600" }}>
                    {isOn ? "Turn Off" : "Turn On"}
                  </Text>
                </Pressable>
              )}
              {editMode && onRemove && (
                <Pressable
                  onPress={onRemove}
                  style={({ pressed }) => ({
                    backgroundColor: "rgba(239,68,68,0.15)",
                    borderWidth: 1,
                    borderColor: "rgba(239,68,68,0.3)",
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ color: "#EF4444", fontSize: 14, fontWeight: "600" }}>
                    Remove from Map
                  </Text>
                </Pressable>
              )}
            </View>

            {/* Room label */}
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              <Text style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, fontFamily: "monospace" }}>
                {device.room.toUpperCase()} {"\u00B7"} {device.position[0].toFixed(1)}, {device.position[1].toFixed(1)}
              </Text>
            </View>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Item Picker Modal ──
export function ItemPicker({
  visible,
  placedDeviceIds,
  onSelect,
  onClose,
}: {
  visible: boolean;
  placedDeviceIds: string[];
  onSelect: (device: Omit<DeviceMarker, "position">) => void;
  onClose: () => void;
}) {
  const unplaced = ALL_DEVICES.filter((d) => !placedDeviceIds.includes(d.id));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1 }} onPress={onClose}>
        <View style={{ flex: 1, justifyContent: "flex-end" }}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <View
              style={{
                backgroundColor: "rgba(17,17,17,0.98)",
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                borderWidth: 1,
                borderColor: "rgba(6,182,212,0.3)",
                borderBottomWidth: 0,
                maxHeight: Dimensions.get("window").height * 0.5,
              }}
            >
              {/* Header */}
              <View style={{ padding: 16, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.06)" }}>
                <Text style={{ color: "#06B6D4", fontSize: 13, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, textAlign: "center" }}>
                  PLACE ITEM
                </Text>
                <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, textAlign: "center", marginTop: 4 }}>
                  {unplaced.length} item{unplaced.length !== 1 ? "s" : ""} available
                </Text>
              </View>

              <ScrollView style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                {unplaced.length === 0 && (
                  <Text style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, textAlign: "center", padding: 24 }}>
                    All items placed
                  </Text>
                )}
                {unplaced.map((device) => (
                  <Pressable
                    key={device.id}
                    onPress={() => onSelect(device)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      backgroundColor: pressed ? "rgba(6,182,212,0.1)" : "transparent",
                    })}
                  >
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: `${device.color}20`,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ fontSize: 18 }}>{device.icon}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "600" }}>{device.name}</Text>
                      <Text style={{ color: "rgba(255,255,255,0.35)", fontSize: 11 }}>{device.room}</Text>
                    </View>
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: device.color,
                        opacity: 0.6,
                      }}
                    />
                  </Pressable>
                ))}
              </ScrollView>

              {/* Cancel */}
              <View style={{ padding: 12, paddingBottom: 32 }}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => ({
                    paddingVertical: 12,
                    alignItems: "center",
                    borderRadius: 12,
                    backgroundColor: "rgba(255,255,255,0.06)",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, fontWeight: "600" }}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Main Component ──
export default function HomeMap3D({
  position,
  activeRoom,
  deviceStates,
  onDeviceTap,
  onDeviceToggle,
  editMode,
  placedDevices = [],
  onPlaceDevice,
  onMoveDevice,
  onRemoveDevice,
  onRequestPlaceAt,
}: Props) {
  const effectiveActiveRoom = activeRoom || position?.room;
  const [selectedDevice, setSelectedDevice] = useState<DeviceMarker | null>(null);
  const [popupVisible, setPopupVisible] = useState(false);

  // Camera orbit state
  const cameraState = useRef<CameraState>({
    theta: 0.72,
    phi: 0.95,
    radius: 18,
    targetX: 0,
    targetZ: 0,
  });

  // Touch tracking
  const touchState = useRef({
    lastX: 0,
    lastY: 0,
    lastDist: 0,
    lastMidX: 0,
    lastMidY: 0,
    fingers: 0,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    didLongPress: false,
  });

  const handleDeviceTap = useCallback((device: DeviceMarker) => {
    setSelectedDevice(device);
    setPopupVisible(true);
    onDeviceTap?.(device);
  }, [onDeviceTap]);

  const handleToggle = useCallback(() => {
    if (selectedDevice) {
      onDeviceToggle?.(selectedDevice.entityId, selectedDevice.domain);
    }
  }, [selectedDevice, onDeviceToggle]);

  const handleRemove = useCallback(() => {
    if (selectedDevice && onRemoveDevice) {
      onRemoveDevice(selectedDevice.id);
      setPopupVisible(false);
      setSelectedDevice(null);
    }
  }, [selectedDevice, onRemoveDevice]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3,
    onPanResponderGrant: (evt) => {
      const touches = evt.nativeEvent.touches;
      const ts = touchState.current;
      ts.fingers = touches.length;
      ts.didLongPress = false;

      if (touches.length === 1) {
        ts.lastX = touches[0].pageX;
        ts.lastY = touches[0].pageY;

        // Long press detection for edit mode
        if (editMode) {
          const startX = touches[0].pageX;
          const startY = touches[0].pageY;
          ts.longPressTimer = setTimeout(() => {
            ts.didLongPress = true;
            // The actual placement happens via the DropPlane in 3D
            // Notify parent to show item picker
            // We use a raycast approach: the DropPlane's onPointerDown fires
          }, 600);
        }
      } else if (touches.length >= 2) {
        if (ts.longPressTimer) { clearTimeout(ts.longPressTimer); ts.longPressTimer = null; }
        const dx = touches[1].pageX - touches[0].pageX;
        const dy = touches[1].pageY - touches[0].pageY;
        ts.lastDist = Math.sqrt(dx * dx + dy * dy);
        ts.lastMidX = (touches[0].pageX + touches[1].pageX) / 2;
        ts.lastMidY = (touches[0].pageY + touches[1].pageY) / 2;
      }
    },
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches;
      const cs = cameraState.current;
      const ts = touchState.current;

      // Cancel long press if finger moved
      if (ts.longPressTimer && touches.length === 1) {
        const dx = Math.abs(touches[0].pageX - ts.lastX);
        const dy = Math.abs(touches[0].pageY - ts.lastY);
        if (dx > 8 || dy > 8) {
          clearTimeout(ts.longPressTimer);
          ts.longPressTimer = null;
        }
      }

      if (touches.length === 1 && ts.fingers === 1 && !ts.didLongPress) {
        const dx = touches[0].pageX - ts.lastX;
        const dy = touches[0].pageY - ts.lastY;
        cs.theta -= dx * 0.008;
        cs.phi = Math.max(0.3, Math.min(1.45, cs.phi - dy * 0.006));
        ts.lastX = touches[0].pageX;
        ts.lastY = touches[0].pageY;
      } else if (touches.length >= 2) {
        const dx = touches[1].pageX - touches[0].pageX;
        const dy = touches[1].pageY - touches[0].pageY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (ts.lastDist > 0) {
          const scale = ts.lastDist / dist;
          cs.radius = Math.max(8, Math.min(35, cs.radius * scale));
        }
        const midX = (touches[0].pageX + touches[1].pageX) / 2;
        const midY = (touches[0].pageY + touches[1].pageY) / 2;
        if (ts.lastMidX > 0) {
          cs.targetX -= (midX - ts.lastMidX) * 0.03;
          cs.targetZ -= (midY - ts.lastMidY) * 0.03;
        }
        ts.lastDist = dist;
        ts.lastMidX = midX;
        ts.lastMidY = midY;
        ts.fingers = touches.length;
      }
    },
    onPanResponderRelease: () => {
      const ts = touchState.current;
      if (ts.longPressTimer) { clearTimeout(ts.longPressTimer); ts.longPressTimer = null; }
      ts.fingers = 0;
      ts.lastDist = 0;
      ts.didLongPress = false;
    },
  }), [editMode]);

  const states = deviceStates || {};

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      {/* Fullscreen 3D Canvas */}
      <View style={{ flex: 1 }} {...panResponder.panHandlers}>
        <Canvas
          style={{ flex: 1 }}
          gl={{ antialias: true }}
          camera={{ position: [12, 10, 12], fov: 30, near: 0.1, far: 100 }}
        >
          <CameraController stateRef={cameraState} />
          <Lighting />
          <Suspense fallback={null}>
            <ApartmentModel activeRoom={effectiveActiveRoom} />
          </Suspense>

          {/* Device markers */}
          {placedDevices.map((device) => {
            const s = states[device.entityId];
            const isOn = s ? ["on", "playing", "cool", "heat", "auto", "cleaning", "returning"].includes(s.state) : false;
            return (
              <DeviceMarker3D
                key={device.id}
                device={device}
                isOn={isOn}
                onTap={() => handleDeviceTap(device)}
                editMode={editMode}
              />
            );
          })}

          {!editMode && position && <PositionBeacon position={position} />}

          {/* Edit mode: invisible drop plane for placement */}
          {editMode && onRequestPlaceAt && (
            <DropPlane onDrop={(x, z) => onRequestPlaceAt(x, z)} />
          )}
        </Canvas>
      </View>

      {/* Edit mode banner */}
      {editMode && (
        <View
          style={{
            position: "absolute",
            bottom: 24,
            left: 16,
            right: 16,
            backgroundColor: "rgba(6,182,212,0.15)",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "rgba(6,182,212,0.3)",
            paddingVertical: 10,
            paddingHorizontal: 16,
            alignItems: "center",
          }}
        >
          <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
            TAP MAP TO PLACE ITEMS
          </Text>
          <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 2 }}>
            Tap a placed item to remove it
          </Text>
        </View>
      )}

      {/* Device popup */}
      <DevicePopup
        device={selectedDevice}
        state={selectedDevice ? states[selectedDevice.entityId] : undefined}
        visible={popupVisible}
        onClose={() => setPopupVisible(false)}
        onToggle={handleToggle}
        editMode={editMode}
        onRemove={editMode ? handleRemove : undefined}
      />
    </View>
  );
}
