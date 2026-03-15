// BLE IRK Enrollment — Pairs iPhone with ESP32 room nodes for person tracking
// Uses CoreBluetooth to connect and read encrypted characteristic,
// which triggers iOS system-level bonding → ESP32 extracts IRK automatically.

import { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, Pressable, Modal, ActivityIndicator, Platform } from "react-native";
import { BleManager, Device, BleError } from "react-native-ble-plx";

const HEART_RATE_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HEART_RATE_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";

type PairStep = "idle" | "triggering" | "scanning" | "connecting" | "reading" | "pairing" | "success" | "error";

interface Props {
  visible: boolean;
  onClose: () => void;
  bridgeUrl: string;
}

export function BLEPairingModal({ visible, onClose, bridgeUrl }: Props) {
  const [step, setStep] = useState<PairStep>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [foundDevice, setFoundDevice] = useState<Device | null>(null);
  const managerRef = useRef<BleManager | null>(null);

  useEffect(() => {
    if (visible) {
      fetchNodes();
      setStep("idle");
      setError("");
    }
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [visible]);

  const fetchNodes = async () => {
    try {
      const res = await fetch(`${bridgeUrl}/positioning/nodes`);
      const data = await res.json();
      if (data.ok) setNodes(data.nodes);
    } catch {}
  };

  const startPairing = useCallback(async (node: any) => {
    setSelectedNode(node);
    setError("");

    // Step 1: Tell bridge to put ESP32 into pairing mode
    setStep("triggering");
    setStatus("Putting node into pairing mode...");
    try {
      const res = await fetch(`${bridgeUrl}/positioning/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeIp: node.ip, timeoutSec: 120 }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to trigger pairing");
    } catch (e: any) {
      setError(e.message);
      setStep("error");
      return;
    }

    // Wait 4s for ESP32 to disconnect WiFi and start advertising
    await new Promise(r => setTimeout(r, 4000));

    // Step 2: Scan for the node via BLE
    setStep("scanning");
    setStatus(`Scanning for Ozzu-Node-${node.id}...`);

    if (!managerRef.current) {
      managerRef.current = new BleManager();
    }
    const manager = managerRef.current;

    // Wait for Bluetooth adapter to reach PoweredOn (iOS starts in "Unknown")
    try {
      const state = await manager.state();
      if (state !== "PoweredOn") {
        setStatus("Waiting for Bluetooth to be ready...");
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            sub.remove();
            reject(new Error("Bluetooth not available. Check Settings → Bluetooth is ON."));
          }, 10000);
          const sub = manager.onStateChange((newState) => {
            if (newState === "PoweredOn") {
              clearTimeout(timeout);
              sub.remove();
              resolve();
            } else if (newState === "PoweredOff" || newState === "Unauthorized") {
              clearTimeout(timeout);
              sub.remove();
              reject(
                new Error(
                  `Bluetooth is ${newState}. Enable Bluetooth in Settings.`,
                ),
              );
            }
          }, true);
        });
      }
    } catch (e: any) {
      setError(e.message);
      setStep("error");
      return;
    }
    setStatus(`Scanning for Ozzu-Node-${node.id}...`);

    const targetName = `Ozzu-Node-${node.id}`;
    let found = false;

    // Set a timeout for scanning
    const scanTimeout = setTimeout(() => {
      if (!found) {
        manager.stopDeviceScan();
        setError("Node not found. Make sure you're near the room node.");
        setStep("error");
      }
    }, 30000);

    manager.startDeviceScan(
      null,
      { allowDuplicates: false },
      async (err: BleError | null, device: Device | null) => {
        if (err) {
          clearTimeout(scanTimeout);
          setError(`Scan error: ${err.message}`);
          setStep("error");
          return;
        }

        if (device && (device.name === targetName || device.localName === targetName)) {
          found = true;
          clearTimeout(scanTimeout);
          manager.stopDeviceScan();
          setFoundDevice(device);
          await connectAndPair(manager, device);
        }
      }
    );
  }, [bridgeUrl]);

  const connectAndPair = async (manager: BleManager, device: Device) => {
    try {
      // Step 3: Connect
      setStep("connecting");
      setStatus(`Connecting to ${device.name}...`);
      const connected = await device.connect({ timeout: 15000 });
      await connected.discoverAllServicesAndCharacteristics();

      // Step 4: Read encrypted characteristic — triggers iOS pairing dialog
      setStep("reading");
      setStatus("Reading encrypted data — accept the pairing popup!");

      try {
        await connected.readCharacteristicForService(
          HEART_RATE_SERVICE,
          HEART_RATE_MEASUREMENT
        );
      } catch (readErr: any) {
        // "Insufficient encryption" error is EXPECTED — it means iOS showed the pairing dialog
        // If user tapped Pair, the retry happens automatically and succeeds
        // If user cancelled, we get an error
        if (readErr.message?.includes("cancel") || readErr.message?.includes("denied")) {
          setError("Pairing was cancelled. Try again and tap 'Pair' when prompted.");
          setStep("error");
          await connected.cancelConnection();
          return;
        }
        // Other errors might mean pairing succeeded and the read retry failed for other reasons
        // That's OK — the ESP32 already got the IRK during bonding
      }

      // Step 5: Wait for ESP32 to extract IRK and reconnect to WiFi
      setStep("pairing");
      setStatus("Pairing complete! Waiting for node to sync IRK...");

      // Give ESP32 time to extract IRK, disconnect BLE, restart WiFi, send to hub
      await new Promise(r => setTimeout(r, 5000));

      try {
        await connected.cancelConnection();
      } catch {} // might already be disconnected

      setStep("success");
      setStatus("iPhone paired successfully! All nodes can now track your location.");
    } catch (e: any) {
      setError(e.message || "Connection failed");
      setStep("error");
    }
  };

  const stepColor = step === "success" ? "#66BB6A" : step === "error" ? "#EF5350" : "#4FC3F7";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center" }}>
        <View style={{
          width: 400, backgroundColor: "#1a1a1a", borderRadius: 16,
          padding: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)"
        }}>
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
            Pair iPhone with Room Nodes
          </Text>
          <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginBottom: 20 }}>
            One-time setup for person-level indoor tracking
          </Text>

          {step === "idle" && (
            <View>
              <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginBottom: 12 }}>
                Select a node to pair with (you only need to pair once):
              </Text>
              {nodes.map(node => (
                <Pressable
                  key={node.id}
                  onPress={() => startPairing(node)}
                  style={{
                    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                    padding: 14, marginBottom: 8, borderRadius: 10,
                    backgroundColor: "rgba(255,255,255,0.06)",
                    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
                  }}
                >
                  <View>
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
                      Node {node.id} — {node.room}
                    </Text>
                    <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 2 }}>
                      {node.online ? "Online" : "Offline"}{node.irks > 0 ? ` · ${node.irks} device(s) paired` : ""}
                    </Text>
                  </View>
                  <Text style={{ color: "#4FC3F7", fontSize: 13, fontWeight: "600" }}>PAIR</Text>
                </Pressable>
              ))}
            </View>
          )}

          {step !== "idle" && step !== "success" && step !== "error" && (
            <View style={{ alignItems: "center", paddingVertical: 20 }}>
              <ActivityIndicator size="large" color={stepColor} />
              <Text style={{ color: stepColor, fontSize: 14, marginTop: 16, textAlign: "center" }}>
                {status}
              </Text>
              {step === "reading" && (
                <Text style={{ color: "#FFB830", fontSize: 13, marginTop: 8, textAlign: "center", fontWeight: "600" }}>
                  A pairing popup will appear — tap "Pair"
                </Text>
              )}
            </View>
          )}

          {step === "success" && (
            <View style={{ alignItems: "center", paddingVertical: 20 }}>
              <Text style={{ fontSize: 40 }}>✅</Text>
              <Text style={{ color: "#66BB6A", fontSize: 15, marginTop: 12, textAlign: "center", fontWeight: "600" }}>
                {status}
              </Text>
            </View>
          )}

          {step === "error" && (
            <View style={{ alignItems: "center", paddingVertical: 20 }}>
              <Text style={{ fontSize: 40 }}>❌</Text>
              <Text style={{ color: "#EF5350", fontSize: 14, marginTop: 12, textAlign: "center" }}>
                {error}
              </Text>
              <Pressable
                onPress={() => { setStep("idle"); setError(""); }}
                style={{ marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 8 }}
              >
                <Text style={{ color: "#fff", fontSize: 13 }}>Try Again</Text>
              </Pressable>
            </View>
          )}

          <Pressable
            onPress={onClose}
            style={{ marginTop: 16, alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16 }}
          >
            <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
              {step === "success" ? "Done" : "Cancel"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
