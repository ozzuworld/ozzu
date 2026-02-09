export interface Room {
  name: string;
  entities: string[];
}

export const rooms: Room[] = [
  {
    name: "Living Room",
    entities: [
      "media_player.main_tv",
      "remote.main_tv",
      "switch.living_room_cam_power",
      "switch.living_room_cam_notifications",
      "switch.living_room_cam_motion_detection",
      "siren.living_room_cam_siren",
    ],
  },
  {
    name: "Kitchen",
    entities: [
      "switch.s_vide_switch",
      "sensor.s_vide_current_temperature",
      "number.s_vide_cooking_temperature",
      "number.s_vide_cooking_time",
      "sensor.s_vide_status",
      "sensor.s_vide_remaining_time",
    ],
  },
  {
    name: "Security",
    entities: [
      "switch.cam1_power",
      "switch.cam1_notifications",
      "switch.cam1_motion_detection",
      "siren.cam1_siren",
    ],
  },
  {
    name: "General",
    entities: ["person.king_kazuma", "todo.shopping_list"],
  },
];
