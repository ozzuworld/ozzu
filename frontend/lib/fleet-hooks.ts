import { useState, useEffect, useRef, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

export interface FleetDevice {
  device_id: string;
  status: string;
  source: string;
  wifi_ssid: string | null;
  lan_ip: string | null;
  public_ip: string | null;
  wg_ip: string | null;
  wg_handshake_age_s: number | null;
  battery_pct: number | null;
  meta: Record<string, any> | null;
  last_seen: string;
  last_seen_age_s: number | null;
  effective_status: string;
  telemetry: Record<string, any>;
}

export interface DeviceInventory {
  device_id: string;
  hardware: {
    model?: string;
    manufacturer?: string;
    serial?: string;
    board?: string;
    cpu_cores?: number;
    cpu_abi?: string;
    screen?: string;
    sensors?: string[];
  };
  os: {
    version?: string;
    sdk?: number;
    kernel?: string;
    arch?: string;
    security_patch?: string;
  };
  security: {
    selinux?: string;
    encryption?: string;
    magisk_version?: string;
    magisk_modules?: any[];
  };
  agent: { version?: string };
  first_seen: string;
  updated_at: string;
}

export interface DeviceTelemetryDetail {
  device_id: string;
  status: string;
  last_seen: string;
  inventory: DeviceInventory | null;
  telemetry: Record<string, any>;
}

const POLL_INTERVAL = 15000;

export interface FleetState {
  devices: FleetDevice[];
  inventory: Record<string, DeviceInventory>;
}

export function useFleetDevices() {
  const [devices, setDevices] = useState<FleetDevice[]>([]);
  const [inventory, setInventory] = useState<Record<string, DeviceInventory>>({});
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetch_ = useCallback(async () => {
    try {
      const base = getBridgeUrl();
      const hdrs = getAuthHeaders();
      const [hbRes, invRes] = await Promise.all([
        fetch(`${base}/infra/heartbeats`, { headers: hdrs }),
        fetch(`${base}/infra/inventory`, { headers: hdrs }),
      ]);
      if (!mountedRef.current) return;
      if (hbRes.ok) {
        const hb = await hbRes.json();
        setDevices(hb.devices || []);
      }
      if (invRes.ok) {
        const inv = await invRes.json();
        const map: Record<string, DeviceInventory> = {};
        for (const d of (inv.devices || [])) map[d.device_id] = d;
        setInventory(map);
      }
      setLoading(false);
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetch_();
    const iv = setInterval(fetch_, POLL_INTERVAL);
    return () => { mountedRef.current = false; clearInterval(iv); };
  }, [fetch_]);

  const refresh = useCallback(() => fetch_(), [fetch_]);
  return { devices, inventory, loading, refresh };
}

export function useDeviceTelemetry(deviceId: string | null) {
  const [detail, setDetail] = useState<DeviceTelemetryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetch_ = useCallback(async () => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${getBridgeUrl()}/infra/telemetry/${deviceId}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DeviceTelemetryDetail = await res.json();
      if (!mountedRef.current) return;
      setDetail(data);
      setLoading(false);
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    mountedRef.current = true;
    fetch_();
    const iv = setInterval(fetch_, POLL_INTERVAL);
    return () => { mountedRef.current = false; clearInterval(iv); };
  }, [fetch_]);

  const refresh = useCallback(() => fetch_(), [fetch_]);
  return { detail, loading, refresh };
}
