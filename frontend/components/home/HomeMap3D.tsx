// HomeMap3D.tsx — Interactive 3D apartment map from LiDAR GLB scan
// Touch controls: drag to rotate, pinch to zoom, two-finger drag to pan
import { Suspense, useRef, useMemo, useEffect, useState, useCallback } from "react";
import { View, Text, PanResponder, Dimensions, Platform } from "react-native";
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

interface Props {
  position?: PositionData | null;
  activeRoom?: string | null;
  onRoomPress?: (roomId: string) => void;
  compact?: boolean;
}

// ── Touch-controlled camera state (shared via ref) ──
interface CameraState {
  theta: number;    // horizontal angle (radians)
  phi: number;      // vertical angle (radians)
  radius: number;   // distance from target
  targetX: number;
  targetZ: number;
}

// ── GLB Model Loader ──
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
        for (let i = 0; i < binary.length; i++) {
          view[i] = binary.charCodeAt(i);
        }

        const loader = new GLTFLoader();
        loader.parse(buffer, "", (gltf) => {
          if (!cancelled) setModel(gltf.scene);
        });
      } catch (err) {
        console.warn("Failed to load apartment GLB:", err);
      }
    }

    loadModel();
    return () => { cancelled = true; };
  }, []);

  // Apply room highlighting
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

// ── Position Beacon ──
function PositionBeacon({ position }: { position: PositionData }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  const pos = useMemo(() => {
    if (position.x != null && position.z != null) {
      return new THREE.Vector3(position.x, -1.55, position.z);
    }
    const room = roomData.rooms.find((r) => r.id === position.room);
    if (room) {
      return new THREE.Vector3(room.center[0], -1.55, room.center[1]);
    }
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

  const beaconColor = position.method?.includes("ble") ? "#22C55E" : "#06B6D4";

  return (
    <group position={pos}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={beaconColor} />
      </mesh>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15, 0.18, 32]} />
        <meshBasicMaterial color={beaconColor} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <circleGeometry args={[0.3 * (1 - position.confidence / 100) + 0.15, 32]} />
        <meshBasicMaterial color={beaconColor} transparent opacity={0.15} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ── ESP32 Node Markers ──
function NodeMarkers() {
  const nodes = roomData.esp32_nodes;
  return (
    <>
      {Object.entries(nodes).map(([id, node]) => (
        <mesh key={id} position={[node.position[0], -1.0, node.position[1]]}>
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshBasicMaterial color="#EF4444" />
        </mesh>
      ))}
    </>
  );
}

// ── Camera Controller (reads shared state ref) ──
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

// ── Main Component ──
export default function HomeMap3D({ position, activeRoom, onRoomPress, compact }: Props) {
  const effectiveActiveRoom = activeRoom || position?.room;

  // Camera orbit state
  const cameraState = useRef<CameraState>({
    theta: 0.72,      // ~41 degrees
    phi: 0.95,         // ~54 degrees from top
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

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
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
        // Single finger: rotate
        const dx = touches[0].pageX - ts.lastX;
        const dy = touches[0].pageY - ts.lastY;
        cs.theta -= dx * 0.008;
        cs.phi = Math.max(0.3, Math.min(1.45, cs.phi - dy * 0.006));
        ts.lastX = touches[0].pageX;
        ts.lastY = touches[0].pageY;
      } else if (touches.length >= 2) {
        // Pinch: zoom
        const dx = touches[1].pageX - touches[0].pageX;
        const dy = touches[1].pageY - touches[0].pageY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (ts.lastDist > 0) {
          const scale = ts.lastDist / dist;
          cs.radius = Math.max(8, Math.min(35, cs.radius * scale));
        }
        // Two-finger drag: pan
        const midX = (touches[0].pageX + touches[1].pageX) / 2;
        const midY = (touches[0].pageY + touches[1].pageY) / 2;
        if (ts.lastMidX > 0) {
          const panDx = midX - ts.lastMidX;
          const panDy = midY - ts.lastMidY;
          cs.targetX -= panDx * 0.03;
          cs.targetZ -= panDy * 0.03;
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

  const mapHeight = compact ? 280 : 380;

  return (
    <View style={{ height: mapHeight, backgroundColor: "#0A0A0A" }}>
      {/* 3D Canvas with touch handler */}
      <View style={{ flex: 1, borderRadius: 16, overflow: "hidden" }} {...panResponder.panHandlers}>
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
          <NodeMarkers />
          {position && <PositionBeacon position={position} />}
        </Canvas>
      </View>

      {/* Room pills overlay at bottom of map */}
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
                effectiveActiveRoom === room.id
                  ? `${room.color}40`
                  : "rgba(0,0,0,0.65)",
              borderRadius: 8,
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderWidth: 1,
              borderColor:
                effectiveActiveRoom === room.id
                  ? `${room.color}60`
                  : "rgba(255,255,255,0.08)",
            }}
          >
            <Text style={{ fontSize: 9 }}>{room.emoji}</Text>
            <Text
              style={{
                fontFamily: "monospace",
                fontSize: 8,
                fontWeight: effectiveActiveRoom === room.id ? "700" : "400",
                color: effectiveActiveRoom === room.id ? room.color : "#94A3B8",
                letterSpacing: 0.3,
              }}
            >
              {room.name.toUpperCase()}
            </Text>
          </View>
        ))}
      </View>

      {/* Position info overlay */}
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
    </View>
  );
}
