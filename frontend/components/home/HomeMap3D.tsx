// HomeMap3D.tsx — 3D apartment map rendered from LiDAR GLB scan
// Uses @react-three/fiber for React Native 3D rendering
import { Suspense, useRef, useMemo, useEffect, useState } from "react";
import { View, Text, Platform } from "react-native";
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
}

interface Props {
  position?: PositionData | null;
  activeRoom?: string | null;
  onRoomPress?: (roomId: string) => void;
}

// ── Room colors ──
const ROOM_COLORS: Record<string, string> = {};
for (const room of roomData.rooms) {
  ROOM_COLORS[room.id] = room.color;
}

// ── GLB Model Loader ──
function ApartmentModel({ activeRoom }: { activeRoom?: string | null }) {
  const [model, setModel] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      try {
        // Load GLB from asset
        const asset = Asset.fromModule(require("../../assets/home-map/apartment.glb"));
        await asset.downloadAsync();
        const uri = asset.localUri || asset.uri;

        // Read as base64 and convert to ArrayBuffer
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
          if (!cancelled) {
            setModel(gltf.scene);
          }
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
        // Default: light gray with slight transparency
        mat.color.set("#d4d4d8");
        mat.transparent = true;
        mat.opacity = 0.85;
        mat.roughness = 0.8;
        mat.metalness = 0.05;
      }
    });

    // Highlight active room's floor
    if (activeRoom) {
      const room = roomData.rooms.find((r) => r.id === activeRoom);
      if (room) {
        const floorMesh = model.getObjectByName(room.floor_mesh);
        if (floorMesh instanceof THREE.Mesh && floorMesh.material) {
          const mat = floorMesh.material as THREE.MeshStandardMaterial;
          mat.color.set(room.color);
          mat.opacity = 0.6;
        }
        // Also highlight duplicate floor (shadow)
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

  // Determine position from room center or explicit coordinates
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

  // Pulse animation
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
      {/* Main dot */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={beaconColor} />
      </mesh>
      {/* Expanding ring */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15, 0.18, 32]} />
        <meshBasicMaterial color={beaconColor} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
      {/* Confidence circle on floor */}
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
        <mesh
          key={id}
          position={[node.position[0], -1.0, node.position[1]]}
        >
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshBasicMaterial color="#EF4444" />
        </mesh>
      ))}
    </>
  );
}

// ── Camera Setup ──
function IsometricCamera() {
  const { camera } = useThree();

  useEffect(() => {
    // Isometric-ish view looking down at the apartment
    camera.position.set(12, 10, 12);
    camera.lookAt(0, -1, 0);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 30;
      camera.updateProjectionMatrix();
    }
  }, [camera]);

  return null;
}

// ── Lighting ──
function Lighting() {
  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[8, 12, 5]} intensity={0.8} castShadow />
      <directionalLight position={[-5, 8, -3]} intensity={0.3} />
    </>
  );
}

// ── Room Labels Overlay (2D on top of 3D) ──
function RoomLabels({ activeRoom }: { activeRoom?: string | null }) {
  // Room labels rendered as RN Text overlay
  // Positions are approximate screen coordinates - would need projection for accuracy
  // For now, show as a legend below the 3D view
  return null;
}

// ── Main Component ──
export default function HomeMap3D({ position, activeRoom, onRoomPress }: Props) {
  const effectiveActiveRoom = activeRoom || position?.room;

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      {/* 3D Canvas */}
      <View style={{ flex: 1, borderRadius: 12, overflow: "hidden" }}>
        <Canvas
          style={{ flex: 1 }}
          gl={{ antialias: true }}
          camera={{ position: [12, 10, 12], fov: 30, near: 0.1, far: 100 }}
        >
          <IsometricCamera />
          <Lighting />
          <Suspense fallback={null}>
            <ApartmentModel activeRoom={effectiveActiveRoom} />
          </Suspense>
          <NodeMarkers />
          {position && <PositionBeacon position={position} />}
        </Canvas>
      </View>

      {/* Room legend */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        {roomData.rooms.map((room) => (
          <View
            key={room.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              backgroundColor:
                effectiveActiveRoom === room.id
                  ? `${room.color}30`
                  : "rgba(255,255,255,0.03)",
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderWidth: 1,
              borderColor:
                effectiveActiveRoom === room.id
                  ? `${room.color}60`
                  : "rgba(255,255,255,0.06)",
            }}
          >
            <Text style={{ fontSize: 12 }}>{room.emoji}</Text>
            <Text
              style={{
                fontFamily: "monospace",
                fontSize: 9,
                fontWeight: effectiveActiveRoom === room.id ? "700" : "400",
                color:
                  effectiveActiveRoom === room.id ? room.color : "#64748B",
                letterSpacing: 0.5,
              }}
            >
              {room.name.toUpperCase()}
            </Text>
            {room.area && (
              <Text
                style={{
                  fontFamily: "monospace",
                  fontSize: 7,
                  color: "#525252",
                }}
              >
                {room.area}m²
              </Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}
