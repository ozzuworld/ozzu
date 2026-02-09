const HA_URL = process.env.EXPO_PUBLIC_HA_URL ?? "http://localhost:8123";
const HA_TOKEN = process.env.EXPO_PUBLIC_HA_TOKEN ?? "";

const wsProtocol = HA_URL.startsWith("https") ? "wss" : "ws";
const hostPart = HA_URL.replace(/^https?:\/\//, "");
const HA_WS_URL = `${wsProtocol}://${hostPart}/api/websocket`;

export { HA_URL, HA_TOKEN, HA_WS_URL };
