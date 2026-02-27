import { useCallback, useMemo } from "react";
import { useEntity } from "./useEntity";
import { useHA } from "./ha-context";
import { HA_URL } from "./config";

const ENTITY_ID = "vacuum.dusk_vader";

export interface VacuumState {
  state: string;
  battery: number | null;
  status: string;
  progress: number;
  area: string | null;
  currentRoom: string | null;
  cleaningTime: string | null;
  suctionLevel: string;
  suctionOptions: string[];
  cleaningMode: string;
  modeOptions: string[];
  mapUrl: string | null;
  rooms: Record<string, { name: string }>;
  mainBrushLeft: number | null;
  sideBrushLeft: number | null;
  filterLeft: number | null;
  sensorDirtyLeft: number | null;
  isCleaning: boolean;
  isDocked: boolean;
  isPaused: boolean;
  isReturning: boolean;
}

export interface VacuumControls {
  start: () => void;
  pause: () => void;
  dock: () => void;
  cleanRooms: (segmentIds: number[]) => void;
  setSuction: (level: string) => void;
  setMode: (mode: string) => void;
}

export function useVacuum(): { state: VacuumState; controls: VacuumControls } {
  const entity = useEntity(ENTITY_ID);
  const battery = useEntity("sensor.dusk_vader_battery_level");
  const statusSensor = useEntity("sensor.dusk_vader_status");
  const progressSensor = useEntity("sensor.dusk_vader_cleaning_progress");
  const areaSensor = useEntity("sensor.dusk_vader_cleaned_area");
  const roomSensor = useEntity("sensor.dusk_vader_current_room");
  const timeSensor = useEntity("sensor.dusk_vader_cleaning_time");
  const suctionSelect = useEntity("select.dusk_vader_suction_level");
  const modeSelect = useEntity("select.dusk_vader_cleaning_mode");
  const mapCamera = useEntity("camera.dusk_vader_map");
  const mainBrush = useEntity("sensor.dusk_vader_main_brush_left");
  const sideBrush = useEntity("sensor.dusk_vader_side_brush_left");
  const filter = useEntity("sensor.dusk_vader_filter_left");
  const sensorDirty = useEntity("sensor.dusk_vader_sensor_dirty_left");
  const { callService } = useHA();

  const vacState = entity?.state ?? "unavailable";

  const mapUrl = useMemo(() => {
    const pic = mapCamera?.attributes?.entity_picture as string | undefined;
    if (!pic) return null;
    return HA_URL + pic;
  }, [mapCamera?.attributes?.entity_picture]);

  const rooms = useMemo(() => {
    return (mapCamera?.attributes?.rooms as Record<string, { name: string }>) ?? {};
  }, [mapCamera?.attributes?.rooms]);

  const state: VacuumState = useMemo(
    () => ({
      state: vacState,
      battery: battery?.state ? parseInt(battery.state, 10) : null,
      status: statusSensor?.state ?? vacState,
      progress: progressSensor?.state ? parseInt(progressSensor.state, 10) : 0,
      area: areaSensor?.state ?? null,
      currentRoom: roomSensor?.state ?? null,
      cleaningTime: timeSensor?.state ?? null,
      suctionLevel: suctionSelect?.state ?? "",
      suctionOptions: (suctionSelect?.attributes?.options as string[]) ?? [],
      cleaningMode: modeSelect?.state ?? "",
      modeOptions: (modeSelect?.attributes?.options as string[]) ?? [],
      mapUrl,
      rooms,
      mainBrushLeft: mainBrush?.state ? parseInt(mainBrush.state, 10) : null,
      sideBrushLeft: sideBrush?.state ? parseInt(sideBrush.state, 10) : null,
      filterLeft: filter?.state ? parseInt(filter.state, 10) : null,
      sensorDirtyLeft: sensorDirty?.state ? parseInt(sensorDirty.state, 10) : null,
      isCleaning: vacState === "cleaning",
      isDocked: vacState === "docked" || vacState === "idle",
      isPaused: vacState === "paused",
      isReturning: vacState === "returning",
    }),
    [
      vacState, battery?.state, statusSensor?.state, progressSensor?.state,
      areaSensor?.state, roomSensor?.state, timeSensor?.state,
      suctionSelect?.state, suctionSelect?.attributes?.options,
      modeSelect?.state, modeSelect?.attributes?.options,
      mapUrl, rooms,
      mainBrush?.state, sideBrush?.state, filter?.state, sensorDirty?.state,
    ]
  );

  const start = useCallback(() => {
    callService("vacuum", "start", {}, { entity_id: ENTITY_ID });
  }, [callService]);

  const pause = useCallback(() => {
    callService("vacuum", "pause", {}, { entity_id: ENTITY_ID });
  }, [callService]);

  const dock = useCallback(() => {
    callService("vacuum", "return_to_base", {}, { entity_id: ENTITY_ID });
  }, [callService]);

  const cleanRooms = useCallback(
    (segmentIds: number[]) => {
      callService("dreame_vacuum", "vacuum_clean_segment", { segments: segmentIds }, { entity_id: ENTITY_ID });
    },
    [callService]
  );

  const setSuction = useCallback(
    (level: string) => {
      callService("select", "select_option", { option: level }, { entity_id: "select.dusk_vader_suction_level" });
    },
    [callService]
  );

  const setMode = useCallback(
    (mode: string) => {
      callService("select", "select_option", { option: mode }, { entity_id: "select.dusk_vader_cleaning_mode" });
    },
    [callService]
  );

  const controls: VacuumControls = useMemo(
    () => ({ start, pause, dock, cleanRooms, setSuction, setMode }),
    [start, pause, dock, cleanRooms, setSuction, setMode]
  );

  return { state, controls };
}
