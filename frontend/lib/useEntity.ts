import { useHA } from "./ha-context";
import type { HassEntity } from "home-assistant-js-websocket";

export function useEntity(entityId: string): HassEntity | undefined {
  const { entities } = useHA();
  return entities[entityId];
}
