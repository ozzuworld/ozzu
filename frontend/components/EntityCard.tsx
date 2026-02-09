import { SwitchCard } from "./SwitchCard";
import { SensorCard } from "./SensorCard";
import { MediaPlayerCard } from "./MediaPlayerCard";
import { NumberCard } from "./NumberCard";

interface EntityCardProps {
  entityId: string;
}

export function EntityCard({ entityId }: EntityCardProps) {
  const domain = entityId.split(".")[0];

  switch (domain) {
    case "switch":
    case "siren":
      return <SwitchCard entityId={entityId} />;
    case "sensor":
    case "person":
    case "todo":
      return <SensorCard entityId={entityId} />;
    case "media_player":
    case "remote":
      return <MediaPlayerCard entityId={entityId} />;
    case "number":
      return <NumberCard entityId={entityId} />;
    default:
      return <SensorCard entityId={entityId} />;
  }
}
