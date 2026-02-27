export interface MapPin {
  id: string;
  label: string;
  icon: string;
  x: number; // % of map width (0-100)
  y: number; // % of map height (0-100)
  type: "ac" | "camera" | "vacuum" | "washer" | "sous_vide" | "media" | "generic";
  primaryEntityId: string;
  relatedEntityIds?: string[];
}

export const MAP_PINS: MapPin[] = [
  {
    id: "ac",
    label: "AC",
    icon: "\u2744\uFE0F",
    x: 65,
    y: 28,
    type: "ac",
    primaryEntityId: "climate.living_room_ac",
  },
  {
    id: "main_tv",
    label: "Main TV",
    icon: "\uD83D\uDCFA",
    x: 55,
    y: 35,
    type: "media",
    primaryEntityId: "media_player.main_tv",
  },
  {
    id: "living_room_cam",
    label: "LR Camera",
    icon: "\uD83D\uDCF9",
    x: 45,
    y: 22,
    type: "camera",
    primaryEntityId: "switch.living_room_cam_power",
    relatedEntityIds: [
      "switch.living_room_cam_motion_detection",
      "switch.living_room_cam_notifications",
      "siren.living_room_cam_siren",
    ],
  },
  {
    id: "sous_vide",
    label: "Sous Vide",
    icon: "\uD83C\uDF73",
    x: 20,
    y: 42,
    type: "sous_vide",
    primaryEntityId: "switch.s_vide_switch",
  },
  {
    id: "washer",
    label: "Washer",
    icon: "\uD83E\uDEE7",
    x: 25,
    y: 55,
    type: "generic",
    primaryEntityId: "switch.151732606804847_power",
    relatedEntityIds: [
      "sensor.151732606804847_status",
      "sensor.151732606804847_progress",
      "sensor.151732606804847_time_remaining",
    ],
  },
  {
    id: "security_cam",
    label: "Security Cam",
    icon: "\uD83D\uDCF9",
    x: 15,
    y: 78,
    type: "camera",
    primaryEntityId: "switch.cam1_power",
    relatedEntityIds: [
      "switch.cam1_motion_detection",
      "switch.cam1_notifications",
      "siren.cam1_siren",
    ],
  },
  {
    id: "dusk_vader",
    label: "Dusk Vader",
    icon: "\uD83E\uDD16",
    x: 50,
    y: 65,
    type: "vacuum",
    primaryEntityId: "vacuum.dusk_vader",
  },
];
