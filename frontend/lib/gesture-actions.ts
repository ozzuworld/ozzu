// Gesture Actions — maps gesture commands to smart home + bridge actions
// Each gesture triggers a specific action sent to the bridge server

import type { GestureCommand } from "./gesture-commands";
import type { BridgeSession } from "./bridge-session";

export interface GestureAction {
  label: string; // Human-readable action name shown in HUD
  icon: string; // Emoji for HUD feedback
}

// Default gesture → action mapping
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

/** Send triggered gesture command to bridge for processing */
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
