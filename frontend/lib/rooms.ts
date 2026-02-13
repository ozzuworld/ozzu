export type Rarity = "legendary" | "epic" | "rare" | "common";

export const RARITY_COLORS: Record<
  Rarity,
  { border: string; glow: string; bg: string; text: string; dim: string }
> = {
  legendary: {
    border: "#F59E0B",
    glow: "#F59E0B",
    bg: "rgba(245,158,11,0.12)",
    text: "#FCD34D",
    dim: "rgba(245,158,11,0.06)",
  },
  epic: {
    border: "#A855F7",
    glow: "#A855F7",
    bg: "rgba(168,85,247,0.12)",
    text: "#C084FC",
    dim: "rgba(168,85,247,0.06)",
  },
  rare: {
    border: "#3B82F6",
    glow: "#3B82F6",
    bg: "rgba(59,130,246,0.12)",
    text: "#93C5FD",
    dim: "rgba(59,130,246,0.06)",
  },
  common: {
    border: "#525252",
    glow: "transparent",
    bg: "rgba(82,82,82,0.12)",
    text: "#A3A3A3",
    dim: "rgba(82,82,82,0.06)",
  },
};

export interface ItemEntity {
  entityId: string;
  label: string;
  icon: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  icon: string;
  rarity: Rarity;
  lore: string;
  primaryEntityId: string;
  entities: ItemEntity[];
}

export interface Room {
  name: string;
  icon: string;
  items: InventoryItem[];
}

export const rooms: Room[] = [
  {
    name: "Living Room",
    icon: "🏠",
    items: [
      {
        id: "main_tv",
        name: "Main TV",
        icon: "📺",
        rarity: "legendary",
        lore: "The centerpiece of the great hall. Its vast display illuminates the chamber with vivid tales and moving pictures.",
        primaryEntityId: "media_player.main_tv",
        entities: [
          { entityId: "media_player.main_tv", label: "Power", icon: "⚡" },
          { entityId: "remote.main_tv", label: "Remote", icon: "🎮" },
        ],
      },
      {
        id: "living_room_cam",
        name: "Living Room Camera",
        icon: "📹",
        rarity: "epic",
        lore: "An ever-watchful sentinel, guarding the living quarters. Its unblinking eye sees all who enter.",
        primaryEntityId: "switch.living_room_cam_power",
        entities: [
          { entityId: "switch.living_room_cam_power", label: "Power", icon: "⚡" },
          { entityId: "switch.living_room_cam_notifications", label: "Notifications", icon: "🔔" },
          { entityId: "switch.living_room_cam_motion_detection", label: "Motion Detection", icon: "👁" },
          { entityId: "siren.living_room_cam_siren", label: "Siren", icon: "🚨" },
        ],
      },
    ],
  },
  {
    name: "Kitchen",
    icon: "🍳",
    items: [
      {
        id: "sous_vide",
        name: "Sous Vide",
        icon: "🍳",
        rarity: "legendary",
        lore: "An ancient art of precision cooking — sealed in vacuum, bathed in warm waters until perfection is achieved.",
        primaryEntityId: "switch.s_vide_switch",
        entities: [
          { entityId: "switch.s_vide_switch", label: "Power", icon: "⚡" },
          { entityId: "sensor.s_vide_current_temperature", label: "Current Temp", icon: "🌡" },
          { entityId: "number.s_vide_cooking_temperature", label: "Target Temp", icon: "🎯" },
          { entityId: "number.s_vide_cooking_time", label: "Cook Time", icon: "⏱" },
          { entityId: "sensor.s_vide_status", label: "Status", icon: "📊" },
          { entityId: "sensor.s_vide_remaining_time", label: "Remaining", icon: "⏳" },
        ],
      },
      {
        id: "midea_washer",
        name: "Washing Machine",
        icon: "🫧",
        rarity: "rare",
        lore: "An enchanted basin that churns linens through cycles of cleansing water. It hums with purpose, releasing garments renewed.",
        primaryEntityId: "switch.151732606804847_power",
        entities: [
          { entityId: "switch.151732606804847_power", label: "Power", icon: "⚡" },
          { entityId: "switch.151732606804847_start", label: "Start", icon: "▶️" },
          { entityId: "sensor.151732606804847_status", label: "Status", icon: "📊" },
          { entityId: "sensor.151732606804847_program", label: "Program", icon: "🔄" },
          { entityId: "sensor.151732606804847_progress", label: "Progress", icon: "📶" },
          { entityId: "sensor.151732606804847_time_remaining", label: "Remaining", icon: "⏳" },
          { entityId: "sensor.151732606804847_temperature", label: "Temp", icon: "🌡" },
          { entityId: "sensor.151732606804847_water_level", label: "Water", icon: "💧" },
        ],
      },
    ],
  },
  {
    name: "Security",
    icon: "🛡",
    items: [
      {
        id: "security_cam",
        name: "Security Camera",
        icon: "📹",
        rarity: "epic",
        lore: "A silent guardian posted at the perimeter. Vigilant and tireless, it sounds the alarm when shadows stir.",
        primaryEntityId: "switch.cam1_power",
        entities: [
          { entityId: "switch.cam1_power", label: "Power", icon: "⚡" },
          { entityId: "switch.cam1_notifications", label: "Notifications", icon: "🔔" },
          { entityId: "switch.cam1_motion_detection", label: "Motion Detection", icon: "👁" },
          { entityId: "siren.cam1_siren", label: "Siren", icon: "🚨" },
        ],
      },
    ],
  },
  {
    name: "General",
    icon: "📦",
    items: [
      {
        id: "kazuma_iphone",
        name: "Kazuma iPhone",
        icon: "📱",
        rarity: "epic",
        lore: "A sorcerer's conduit, bound to its master by invisible threads. It whispers his whereabouts and vital signs across any distance.",
        primaryEntityId: "device_tracker.kazuma_iphone",
        entities: [
          { entityId: "device_tracker.kazuma_iphone", label: "Location", icon: "📍" },
          { entityId: "sensor.kazuma_iphone_battery_level", label: "Battery", icon: "🔋" },
          { entityId: "sensor.kazuma_iphone_battery_state", label: "Charging", icon: "⚡" },
          { entityId: "sensor.kazuma_iphone_connection_type", label: "Connection", icon: "📶" },
          { entityId: "sensor.kazuma_iphone_ssid", label: "Wi-Fi", icon: "📡" },
          { entityId: "sensor.kazuma_iphone_storage", label: "Storage", icon: "💾" },
          { entityId: "sensor.kazuma_iphone_geocoded_location", label: "Address", icon: "🗺" },
        ],
      },
      {
        id: "king_kazuma",
        name: "King Kazuma",
        icon: "👤",
        rarity: "common",
        lore: "The master of this domain. His presence is felt throughout every connected chamber.",
        primaryEntityId: "person.king_kazuma",
        entities: [
          { entityId: "person.king_kazuma", label: "Presence", icon: "👤" },
        ],
      },
      {
        id: "shopping_list",
        name: "Shopping List",
        icon: "📝",
        rarity: "common",
        lore: "A weathered scroll of provisions yet to be acquired. Its entries shift with the needs of the household.",
        primaryEntityId: "todo.shopping_list",
        entities: [
          { entityId: "todo.shopping_list", label: "List", icon: "📝" },
        ],
      },
    ],
  },
];
