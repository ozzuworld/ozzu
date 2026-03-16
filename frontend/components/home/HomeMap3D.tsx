// HomeMap3D.tsx — Fullscreen interactive 3D apartment with device markers
// Touch: drag to rotate, pinch to zoom, two-finger pan
// Devices placed at real physical positions, tappable for controls
import { Suspense, useRef, useMemo, useEffect, useState, useCallback } from "react";
import { View, Text, PanResponder, Pressable, Modal, ScrollView, Platform } from "react-native";
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

interface DeviceMarker {
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
}

// ── Device positions mapped to real apartment coordinates ──
// Only devices with visible physical locations in the LiDAR scan
export const DEVICE_MARKERS: DeviceMarker[] = [
  // Living Room — TV is against the south wall near the couch
  {
    id: "main_tv", name: "Main TV", icon: "📺",
    entityId: "media_player.main_tv", domain: "media_player",
    position: [2.20, -4.80], color: "#CE93D8", room: "living",
  },
  // Living Room — Spotify plays through the TV area
  {
    id: "spotify", name: "Spotify", icon: "🎵",
    entityId: "media_player.spotify_king_kazuma", domain: "media_player",
    position: [1.15, -3.33], color: "#1DB954", room: "living",
  },
  // Living Room — AC unit on south wall
  {
    id: "ac", name: "AC", icon: "❄️",
    entityId: "climate.living_room_ac", domain: "climate",
    position: [0.30, -5.10], color: "#4FC3F7", room: "living",
  },
  // Kitchen — Washing machine (appliance visible in scan)
  {
    id: "midea_washer", name: "Washer", icon: "🫧",
    entityId: "switch.151732606804847_power", domain: "switch",
    position: [-3.97, -0.74], color: "#3B82F6", room: "kitchen",
  },
];

// Unassigned devices — no visible physical spot in LiDAR scan
// Future: user can manually assign positions via drag-and-drop
export const UNASSIGNED_DEVICES = [
  { id: "living_room_cam", name: "LR Camera", entityId: "switch.living_room_cam_power" },
  { id: "security_cam", name: "Security Camera", entityId: "switch.cam1_power" },
  { id: "sous_vide", name: "Sous Vide", entityId: "switch.s_vide_switch" },
  { id: "dusk_vader", name: "Dusk Vader", entityId: "vacuum.dusk_vader" },
  { id: "kazuma_iphone", name: "Kazuma iPhone", entityId: "device_tracker.kazuma_iphone" },
  { id: "king_kazuma", name: "King Kazuma", entityId: "person.king_kazuma" },
  { id: "shopping_list", name: "Shopping List", entityId: "todo.shopping_list" },
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
}: {
  device: DeviceMarker;
  isOn: boolean;
  onTap: () => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    if (isOn) {
      // Gentle float animation when active
      const t = clock.getElapsedTime();
      meshRef.current.position.y = -1.15 + Math.sin(t * 2 + device.position[0]) * 0.04;
      // Glow pulse
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
      {/* Marker sphere */}
      <mesh
        ref={meshRef}
        position={[0, -1.20, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTap();
        }}
      >
        <sphereGeometry args={[isOn ? 0.16 : 0.12, 16, 16]} />
        <meshBasicMaterial
          color={isOn ? device.color : "#525252"}
          transparent
          opacity={isOn ? 0.95 : 0.5}
        />
      </mesh>
      {/* Glow ring on floor */}
      <mesh
        ref={glowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -1.54, 0]}
      >
        <circleGeometry args={[0.3, 24]} />
        <meshBasicMaterial
          color={device.color}
          transparent
          opacity={isOn ? 0.25 : 0.08}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Vertical line connecting marker to floor */}
      <mesh position={[0, -1.37, 0]}>
        <cylinderGeometry args={[0.008, 0.008, 0.34, 4]} />
        <meshBasicMaterial
          color={device.color}
          transparent
          opacity={isOn ? 0.4 : 0.15}
        />
      </mesh>
    </group>
  );
}

// ── Position Beacon ──
function PositionBeacon({ position }: { position: PositionData }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  const pos = useMemo(() => {
    if (position.x != null && position.z != null) {
      return new THREE.Vector3(position.x, -1.55, position.z);
    }
    const room = roomData.rooms.find((r) => r.id === position.room);
    if (room) return new THREE.Vector3(room.center[0], -1.55, room.center[1]);
    return new THREE.Vector3(0, -1.55, 0);
  }, [position]);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const pulse = Math.sin(clock.getElapsedTime() * 3) * 0.03 + 0.12;
      meshRef.current.scale.setScalar(pulse / 0.12);
    }
    if (ringRef.current) {
      const expand = (clock.getElapsedTime() % 2) / 2;
      ringRef.current.scale.setScalar(1 + expand * 3);
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - expand);
    }
  });

  const color = position.method?.includes("ble") ? "#22C55E" : "#06B6D4";

  return (
    <group position={pos}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15, 0.18, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ── ESP32 Node Markers ──
function NodeMarkers() {
  return (
    <>
      {Object.entries(roomData.esp32_nodes).map(([id, node]) => (
        <mesh key={id} position={[node.position[0], -1.0, node.position[1]]}>
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshBasicMaterial color="#EF4444" />
        </mesh>
      ))}
    </>
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
}: {
  device: DeviceMarker | null;
  state?: { state: string; attributes?: any };
  visible: boolean;
  onClose: () => void;
  onToggle: () => void;
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
              borderColor: isOn ? `${device.color}40` : "rgba(255,255,255,0.1)",
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
                  {isUnavailable ? "Offline" : entityState}
                </Text>
              </View>
              {/* Status dot */}
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
            </View>

            {/* AC temperature display */}
            {device.domain === "climate" && state?.attributes?.current_temperature && (
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
            {device.domain === "vacuum" && (
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

            {/* Action button */}
            {!isUnavailable && (
              <View style={{ padding: 16, paddingTop: device.domain === "climate" || device.domain === "vacuum" ? 0 : 16 }}>
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
              </View>
            )}

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

// ── Main Component ──
export default function HomeMap3D({ position, activeRoom, deviceStates, onDeviceTap, onDeviceToggle }: Props) {
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

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3,
    onPanResponderGrant: (evt) => {
      const touches = evt.nativeEvent.touches;
      touchState.current.fingers = touches.length;
      if (touches.length === 1) {
        touchState.current.lastX = touches[0].pageX;
        touchState.current.lastY = touches[0].pageY;
      } else if (touches.length >= 2) {
        const dx = touches[1].pageX - touches[0].pageX;
        const dy = touches[1].pageY - touches[0].pageY;
        touchState.current.lastDist = Math.sqrt(dx * dx + dy * dy);
        touchState.current.lastMidX = (touches[0].pageX + touches[1].pageX) / 2;
        touchState.current.lastMidY = (touches[0].pageY + touches[1].pageY) / 2;
      }
    },
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches;
      const cs = cameraState.current;
      const ts = touchState.current;

      if (touches.length === 1 && ts.fingers === 1) {
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
      touchState.current.fingers = 0;
      touchState.current.lastDist = 0;
    },
  }), []);

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
          {DEVICE_MARKERS.map((device) => {
            const s = states[device.entityId];
            const isOn = s ? ["on", "playing", "cool", "heat", "auto", "cleaning", "returning"].includes(s.state) : false;
            return (
              <DeviceMarker3D
                key={device.id}
                device={device}
                isOn={isOn}
                onTap={() => handleDeviceTap(device)}
              />
            );
          })}

          <NodeMarkers />
          {position && <PositionBeacon position={position} />}
        </Canvas>
      </View>

      {/* Room pills overlay — bottom of screen */}
      <View
        style={{
          position: "absolute",
          bottom: 8,
          left: 0,
          right: 0,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          paddingHorizontal: 8,
          justifyContent: "center",
        }}
      >
        {roomData.rooms.map((room) => (
          <View
            key={room.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              backgroundColor:
                effectiveActiveRoom === room.id ? `${room.color}40` : "rgba(0,0,0,0.6)",
              borderRadius: 8,
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderWidth: 1,
              borderColor:
                effectiveActiveRoom === room.id ? `${room.color}60` : "rgba(255,255,255,0.06)",
            }}
          >
            <Text style={{ fontSize: 9 }}>{room.emoji}</Text>
            <Text
              style={{
                fontFamily: "monospace",
                fontSize: 8,
                fontWeight: effectiveActiveRoom === room.id ? "700" : "400",
                color: effectiveActiveRoom === room.id ? room.color : "#94A3B8",
              }}
            >
              {room.name.toUpperCase()}
            </Text>
          </View>
        ))}
      </View>

      {/* Position info overlay — top right */}
      {position && (
        <View
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            backgroundColor: "rgba(0,0,0,0.7)",
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderWidth: 1,
            borderColor: "rgba(34,197,94,0.3)",
          }}
        >
          <Text style={{ color: "#22C55E", fontSize: 9, fontFamily: "monospace", fontWeight: "600" }}>
            {position.room?.toUpperCase()}
            {position.x != null ? ` (${position.x.toFixed(1)},${position.z?.toFixed(1)})` : ""}
          </Text>
          {position.furniture && (
            <Text style={{ color: "#94A3B8", fontSize: 8, fontFamily: "monospace" }}>
              near {position.furniture}
            </Text>
          )}
        </View>
      )}

      {/* Device popup */}
      <DevicePopup
        device={selectedDevice}
        state={selectedDevice ? states[selectedDevice.entityId] : undefined}
        visible={popupVisible}
        onClose={() => setPopupVisible(false)}
        onToggle={handleToggle}
      />
    </View>
  );
}
