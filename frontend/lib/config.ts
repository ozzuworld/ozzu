import { Platform } from "react-native";

function getHAUrl(): string {
  // On web, if served over HTTPS (e.g. via nginx), use the same origin
  // so WebSocket goes through WSS and avoids mixed content
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const loc = window.location;
    if (loc.protocol === "https:") {
      return loc.origin;
    }
  }
  return process.env.EXPO_PUBLIC_HA_URL ?? "https://home.ozzu.world";
}

const HA_URL = getHAUrl();
const HA_TOKEN = process.env.EXPO_PUBLIC_HA_TOKEN ?? "";

const wsProtocol = HA_URL.startsWith("https") ? "wss" : "ws";
const hostPart = HA_URL.replace(/^https?:\/\//, "");
const HA_WS_URL = `${wsProtocol}://${hostPart}/api/websocket`;

export { HA_URL, HA_TOKEN, HA_WS_URL };
