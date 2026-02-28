// Gesture Actions — maps gesture commands to smart home + bridge actions
// Each gesture triggers a specific action sent to the bridge server

import type { GestureCommand } from "./gesture-commands";
import type { BridgeSession } from "./bridge-session";
import type { DeviceTarget, DeviceDomain } from "./device-map";

export interface GestureAction {
  label: string; // Human-readable action name shown in HUD
  icon: string; // Emoji for HUD feedback
}

// Default gesture → action mapping (untargeted mode)
// These are the actions sent to the bridge; the bridge decides what to do
const GESTURE_ACTIONS: Record<string, GestureAction> = {
  pinch: { label: "TOGGLE", icon: "\u{1F4A1}" },
  grab: { label: "DIM", icon: "\u{1F506}" },
  open_palm: { label: "STOP", icon: "\u{1F6D1}" },
  thumbs_up: { label: "OK", icon: "\u{2705}" },
  peace: { label: "CAPTURE", icon: "\u{1F4F8}" },
  ok_sign: { label: "CONFIRM", icon: "\u{1F44C}" },
  point: { label: "SELECT", icon: "\u{1F4CD}" },
  swipe_left: { label: "PREV", icon: "\u{23EE}" },
  swipe_right: { label: "NEXT", icon: "\u{23ED}" },
  // Compound gestures
  "point+pinch": { label: "ACTIVATE", icon: "\u{26A1}" },
};

// Finger count actions (1-5)
const FINGER_COUNT_ACTIONS: Record<number, GestureAction> = {
  1: { label: "ROOM 1", icon: "1\u{FE0F}\u{20E3}" },
  2: { label: "ROOM 2", icon: "2\u{FE0F}\u{20E3}" },
  3: { label: "ROOM 3", icon: "3\u{FE0F}\u{20E3}" },
  4: { label: "SCENE 4", icon: "4\u{FE0F}\u{20E3}" },
  5: { label: "ALL OFF", icon: "5\u{FE0F}\u{20E3}" },
};

// Domain-aware gesture → HA action mappings (targeted mode)
interface TargetedAction {
  service: string; // HA service: "media_play_pause", "toggle", etc.
  label: string;
  icon: string;
  continuous?: boolean; // if true, sends continuous values
}

const DOMAIN_ACTIONS: Record<DeviceDomain, Record<string, TargetedAction>> = {
  media_player: {
    pinch: { service: "media_play_pause", label: "PLAY/PAUSE", icon: "\u{23EF}" },
    swipe_left: { service: "media_previous_track", label: "PREV TRACK", icon: "\u{23EE}" },
    swipe_right: { service: "media_next_track", label: "NEXT TRACK", icon: "\u{23ED}" },
    grab: { service: "volume_set", label: "VOLUME", icon: "\u{1F50A}", continuous: true },
    open_palm: { service: "media_stop", label: "STOP", icon: "\u{23F9}" },
    thumbs_up: { service: "turn_on", label: "ON", icon: "\u{2705}" },
  },
  climate: {
    pinch: { service: "toggle", label: "TOGGLE", icon: "\u{2744}" },
    grab: { service: "set_temperature", label: "TEMP", icon: "\u{1F321}", continuous: true },
    thumbs_up: { service: "set_temperature", label: "TEMP UP", icon: "\u{1F525}" },
    peace: { service: "set_temperature", label: "TEMP DOWN", icon: "\u{2744}" },
  },
  switch: {
    pinch: { service: "toggle", label: "TOGGLE", icon: "\u{1F4A1}" },
    thumbs_up: { service: "turn_on", label: "ON", icon: "\u{2705}" },
    grab: { service: "turn_off", label: "OFF", icon: "\u{26D4}" },
  },
  vacuum: {
    pinch: { service: "toggle", label: "TOGGLE", icon: "\u{1F916}" },
    thumbs_up: { service: "start", label: "START", icon: "\u{25B6}" },
    grab: { service: "return_to_base", label: "DOCK", icon: "\u{1F3E0}" },
  },
};

export function getActionForCommand(command: GestureCommand): GestureAction | null {
  // Compound gesture takes priority
  if (command.compound && GESTURE_ACTIONS[command.compound]) {
    return GESTURE_ACTIONS[command.compound];
  }

  // Finger count
  if (command.gesture === "finger_count" && command.fingerCount) {
    return FINGER_COUNT_ACTIONS[command.fingerCount] || null;
  }

  return GESTURE_ACTIONS[command.gesture] || null;
}

/** Get the HA action for a gesture when targeting a specific device */
export function getTargetedAction(
  gesture: string,
  target: DeviceTarget
): TargetedAction | null {
  const domainActions = DOMAIN_ACTIONS[target.domain];
  if (!domainActions) return null;
  return domainActions[gesture] || null;
}

/** Send triggered gesture command to bridge for processing (untargeted) */
export function executeGestureCommand(
  bridge: BridgeSession,
  command: GestureCommand
): GestureAction | null {
  const action = getActionForCommand(command);
  if (!action) return null;

  bridge.sendGestureCommand({
    gesture: command.compound || command.gesture,
    action: action.label,
    fingerCount: command.fingerCount,
    timestamp: command.timestamp,
  });

  return action;
}

/** Send targeted gesture command to bridge for HA device control */
export function sendTargetedGestureCommand(
  bridge: BridgeSession,
  gesture: string,
  target: DeviceTarget,
  continuousValue?: number
): GestureAction | null {
  const action = getTargetedAction(gesture, target);
  if (!action) return null;

  bridge.sendTargetedGestureCommand({
    gesture,
    service: action.service,
    entityId: target.entityId,
    domain: target.domain,
    deviceName: target.name,
    continuous: action.continuous || false,
    continuousValue,
    attribute: target.attribute,
    min: target.min,
    max: target.max,
    timestamp: Date.now(),
  });

  return { label: action.label, icon: action.icon };
}
