import { useMemo } from "react";
import { useHA } from "./ha-context";
import { rooms } from "./rooms";

const allEntityIds = rooms.flatMap((room) =>
  room.items.flatMap((item) => item.entities.map((e) => e.entityId))
);

const entityLabelMap = new Map<string, string>();
for (const room of rooms) {
  for (const item of room.items) {
    for (const e of item.entities) {
      entityLabelMap.set(e.entityId, `${item.name} — ${e.label}`);
    }
  }
}

export function useEntitySummary(): string {
  const { entities } = useHA();

  return useMemo(() => {
    const lines: string[] = [];
    for (const id of allEntityIds) {
      const entity = entities[id];
      if (!entity) continue;
      const label = entityLabelMap.get(id) ?? id;
      const unit = entity.attributes?.unit_of_measurement ?? "";
      lines.push(`- ${label} (${id}): ${entity.state}${unit ? ` ${unit}` : ""}`);
    }
    return lines.join("\n");
  }, [entities]);
}
