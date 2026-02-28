// Device Map — maps COCO object detection labels to Home Assistant entities
// Supports calibration overrides stored via expo-file-system

import * as FileSystem from "expo-file-system";

const STORAGE_FILE = `${FileSystem.documentDirectory}gesture-device-map.json`;

export type DeviceDomain = "media_player" | "climate" | "switch" | "vacuum";

export interface DeviceTarget {
  id: string; // e.g. "main_tv"
  name: string; // display name: "Main TV"
  entityId: string; // HA entity: "media_player.main_tv"
  domain: DeviceDomain;
  continuous: boolean; // supports continuous gesture control (volume, temp)
  attribute?: string; // continuous attribute name
  min?: number; // continuous min value
  max?: number; // continuous max value
}

// Default COCO class → HA device mappings
const DEFAULT_MAP: Record<string, DeviceTarget> = {
  tv: {
    id: "main_tv",
    name: "Main TV",
    entityId: "media_player.main_tv",
    domain: "media_player",
    continuous: true,
    attribute: "volume_level",
    min: 0,
    max: 1,
  },
  laptop: {
    id: "spotify",
    name: "Spotify",
    entityId: "media_player.spotify_king_kazuma",
    domain: "media_player",
    continuous: true,
    attribute: "volume_level",
    min: 0,
    max: 1,
  },
  refrigerator: {
    id: "living_room_ac",
    name: "AC",
    entityId: "climate.living_room_ac",
    domain: "climate",
    continuous: true,
    attribute: "temperature",
    min: 16,
    max: 30,
  },
  "cell phone": {
    id: "living_room_cam",
    name: "Camera",
    entityId: "switch.living_room_cam_power",
    domain: "switch",
    continuous: false,
  },
  microwave: {
    id: "sous_vide",
    name: "Sous Vide",
    entityId: "switch.s_vide_switch",
    domain: "switch",
    continuous: false,
  },
};

// Runtime map: defaults + calibration overrides
let deviceMap: Record<string, DeviceTarget> = { ...DEFAULT_MAP };

/** Load calibration overrides from file storage */
export async function loadCalibration(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    if (info.exists) {
      const stored = await FileSystem.readAsStringAsync(STORAGE_FILE);
      const overrides: Record<string, DeviceTarget> = JSON.parse(stored);
      deviceMap = { ...DEFAULT_MAP, ...overrides };
    }
  } catch {
    // Use defaults on error
  }
}

/** Save a calibration override: assign a COCO label to a device target */
export async function saveCalibration(
  cocoLabel: string,
  target: DeviceTarget
): Promise<void> {
  deviceMap[cocoLabel] = target;
  try {
    // Only save overrides (non-default entries)
    const overrides: Record<string, DeviceTarget> = {};
    for (const [label, device] of Object.entries(deviceMap)) {
      if (!DEFAULT_MAP[label] || DEFAULT_MAP[label].entityId !== device.entityId) {
        overrides[label] = device;
      }
    }
    await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(overrides));
  } catch {
    // Silent fail — mapping still active in memory
  }
}

/** Clear all calibration overrides */
export async function clearCalibration(): Promise<void> {
  deviceMap = { ...DEFAULT_MAP };
  try {
    await FileSystem.deleteAsync(STORAGE_FILE, { idempotent: true });
  } catch {}
}

/** Find a device target for a detected COCO object label */
export function findDeviceForObject(cocoLabel: string): DeviceTarget | null {
  return deviceMap[cocoLabel.toLowerCase()] || null;
}

/** Get all available device targets (for calibration UI) */
export function getAllDeviceTargets(): DeviceTarget[] {
  return [
    DEFAULT_MAP.tv!,
    DEFAULT_MAP.laptop!,
    DEFAULT_MAP.refrigerator!,
    DEFAULT_MAP["cell phone"]!,
    DEFAULT_MAP.microwave!,
  ];
}

/** Get current mapping table (for debug/calibration display) */
export function getCurrentMap(): Record<string, DeviceTarget> {
  return { ...deviceMap };
}
