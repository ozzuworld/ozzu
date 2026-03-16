// Device Map — maps rooms to controllable Home Assistant devices
// Swipe-down cycles through devices in the current room (from positioning system)

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

// Room → devices available for gesture control
// Order matters: first device is the default target for each room
const ROOM_DEVICES: Record<string, DeviceTarget[]> = {
  living_room: [
    {
      id: "living_room_ac",
      name: "AC",
      entityId: "climate.living_room_ac",
      domain: "climate",
      continuous: true,
      attribute: "temperature",
      min: 16,
      max: 30,
    },
    {
      id: "main_tv",
      name: "Main TV",
      entityId: "media_player.main_tv",
      domain: "media_player",
      continuous: true,
      attribute: "volume_level",
      min: 0,
      max: 1,
    },
    {
      id: "spotify",
      name: "Spotify",
      entityId: "media_player.spotify_king_kazuma",
      domain: "media_player",
      continuous: true,
      attribute: "volume_level",
      min: 0,
      max: 1,
    },
    {
      id: "living_room_cam",
      name: "Camera",
      entityId: "switch.living_room_cam_power",
      domain: "switch",
      continuous: false,
    },
  ],
  kitchen: [
    {
      id: "sous_vide",
      name: "Sous Vide",
      entityId: "switch.s_vide_switch",
      domain: "switch",
      continuous: false,
    },
  ],
  office: [
    {
      id: "living_room_ac",
      name: "AC",
      entityId: "climate.living_room_ac",
      domain: "climate",
      continuous: true,
      attribute: "temperature",
      min: 16,
      max: 30,
    },
  ],
  bedroom: [],
};

/** Get devices for a room */
export function getDevicesForRoom(room: string): DeviceTarget[] {
  const normalized = room.toLowerCase().replace(/[\s-]+/g, "_");
  return ROOM_DEVICES[normalized] || [];
}

/** Get next device in room (for cycling with swipe-down) */
export function getNextDevice(
  room: string,
  currentDeviceId: string | null
): DeviceTarget | null {
  const devices = getDevicesForRoom(room);
  if (devices.length === 0) return null;
  if (!currentDeviceId) return devices[0];
  const idx = devices.findIndex((d) => d.id === currentDeviceId);
  return devices[(idx + 1) % devices.length];
}

/** Get all rooms that have devices */
export function getRoomsWithDevices(): string[] {
  return Object.keys(ROOM_DEVICES).filter(
    (r) => ROOM_DEVICES[r].length > 0
  );
}

/** Find device by entity ID across all rooms */
export function findDeviceByEntityId(
  entityId: string
): DeviceTarget | null {
  for (const devices of Object.values(ROOM_DEVICES)) {
    const found = devices.find((d) => d.entityId === entityId);
    if (found) return found;
  }
  return null;
}
