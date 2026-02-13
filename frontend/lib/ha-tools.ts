import { rooms } from "./rooms";

// Domains the AI is allowed to control (not sensors, trackers, persons, todos)
const CONTROLLABLE_DOMAINS = new Set([
  "switch",
  "siren",
  "media_player",
  "number",
  "select",
]);

/** Entity IDs from rooms.ts that belong to controllable domains. */
export const ALLOWED_ENTITY_IDS: Set<string> = new Set(
  rooms
    .flatMap((r) => r.items)
    .flatMap((item) => item.entities)
    .map((e) => e.entityId)
    .filter((id) => CONTROLLABLE_DOMAINS.has(id.split(".")[0]))
);

// ── Function Declarations for Gemini ──

const entityIdParam = {
  type: "STRING" as const,
  description: "The Home Assistant entity_id to target, e.g. switch.living_room_cam_power",
};

export const HA_FUNCTION_DECLARATIONS = [
  {
    name: "turn_on",
    description: "Turn on a device (switch, siren, or media player)",
    parameters: {
      type: "OBJECT" as any,
      properties: { entity_id: entityIdParam },
      required: ["entity_id"],
    },
  },
  {
    name: "turn_off",
    description: "Turn off a device (switch, siren, or media player)",
    parameters: {
      type: "OBJECT" as any,
      properties: { entity_id: entityIdParam },
      required: ["entity_id"],
    },
  },
  {
    name: "toggle",
    description: "Toggle a device on or off",
    parameters: {
      type: "OBJECT" as any,
      properties: { entity_id: entityIdParam },
      required: ["entity_id"],
    },
  },
  {
    name: "set_number_value",
    description:
      "Set a numeric value on a number entity (e.g. temperature, cooking time)",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        entity_id: entityIdParam,
        value: {
          type: "NUMBER" as const,
          description: "The numeric value to set",
        },
      },
      required: ["entity_id", "value"],
    },
  },
  {
    name: "media_play_pause",
    description: "Toggle play/pause on a media player",
    parameters: {
      type: "OBJECT" as any,
      properties: { entity_id: entityIdParam },
      required: ["entity_id"],
    },
  },
  {
    name: "select_option",
    description:
      "Select an option on a select entity (e.g. washing machine cycle)",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        entity_id: entityIdParam,
        option: {
          type: "STRING" as const,
          description: "The option to select",
        },
      },
      required: ["entity_id", "option"],
    },
  },
];

// ── Tool call resolver ──

export interface ResolvedToolCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  entityId: string;
}

/**
 * Maps a Gemini function call to a Home Assistant service call.
 * Returns null if the entity is not in the allowlist.
 */
export function resolveToolCall(
  name: string,
  args: Record<string, unknown>
): ResolvedToolCall | null {
  const entityId = args.entity_id as string | undefined;
  if (!entityId || !ALLOWED_ENTITY_IDS.has(entityId)) return null;

  const domain = entityId.split(".")[0];

  switch (name) {
    case "turn_on":
      return { domain, service: "turn_on", entityId };
    case "turn_off":
      return { domain, service: "turn_off", entityId };
    case "toggle":
      return { domain, service: "toggle", entityId };
    case "set_number_value":
      return {
        domain: "number",
        service: "set_value",
        data: { value: args.value as number },
        entityId,
      };
    case "media_play_pause":
      return {
        domain: "media_player",
        service: "media_play_pause",
        entityId,
      };
    case "select_option":
      return {
        domain: "select",
        service: "select_option",
        data: { option: args.option as string },
        entityId,
      };
    default:
      return null;
  }
}
