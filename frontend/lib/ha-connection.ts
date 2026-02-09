import {
  createConnection,
  createLongLivedTokenAuth,
  type Connection,
} from "home-assistant-js-websocket";
import { HA_URL, HA_TOKEN } from "./config";

export async function connectToHA(): Promise<Connection> {
  const auth = createLongLivedTokenAuth(HA_URL, HA_TOKEN);
  const connection = await createConnection({ auth });
  return connection;
}
