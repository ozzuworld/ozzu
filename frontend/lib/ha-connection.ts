import {
  createConnection,
  createLongLivedTokenAuth,
  type Connection,
} from "home-assistant-js-websocket";
import { HA_URL, HA_TOKEN } from "./config";

const CONNECTION_TIMEOUT_MS = 15000;

export async function connectToHA(): Promise<Connection> {
  const auth = createLongLivedTokenAuth(HA_URL, HA_TOKEN);
  const connection = await Promise.race([
    createConnection({ auth }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`HA connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`)), CONNECTION_TIMEOUT_MS)
    ),
  ]);
  return connection;
}
