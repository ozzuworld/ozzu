// infra-hooks.ts — Hook for infrastructure state from /infra/state
import { useState, useEffect, useRef, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

// ── Types ──

export interface DeviceResources {
  disk: { size: string; used: string; avail: string; pct: string };
  memory: { totalMb: number; usedMb: number; freeMb: number };
  cpu: { load1m: string; load5m: string; load15m: string };
}

export interface InfraDevice {
  name: string;
  ip: string;
  role: string;
  reachable: boolean;
  hostname?: string;
  uptime?: string;
  resources?: DeviceResources;
  services?: Record<string, string>;
  latencyMs?: number;
  extended?: {
    hostapdClients?: any[];
    networkIo?: Record<string, { rxBytes: number; txBytes: number }>;
    temperature?: number;
  };
}

export interface ESP32Node {
  id: number;
  room: string;
  ip: string;
  mac: string | null;
  reachable: boolean;
  status: string;
  deployed?: boolean;
}

export interface DockerContainer {
  name: string;
  status: string;
  state: string;
  image: string;
}

export interface RouterState {
  timestamp?: string;
  model?: string | null;
  firmware?: string | null;
  uptime?: any;
  cpu?: any;
  wan?: any;
  dhcp?: { clients?: any[]; settings?: any };
  vpn?: any;
  error?: string;
}

export interface PositioningHub {
  service: string;
  config?: any;
  lastOutput?: string;
  irkStore?: string;
  otaFirmware?: string;
  wifiAp?: string;
}

export interface InfraState {
  timestamp: string;
  network: {
    vpn: { status: string; localIp: string | null; peerIp: string };
    routes: string[];
    lan: { subnet: string };
    gcpIps: string[];
  };
  devices: Record<string, InfraDevice>;
  esp32Nodes: ESP32Node[];
  gcp: {
    hostname: string;
    uptime: string;
    resources: DeviceResources;
    docker: DockerContainer[];
  };
  positioningHub: PositioningHub;
  router: RouterState;
  probeTimeMs: number;
}

const POLL_INTERVAL = 30000;

export function useInfraState() {
  const [state, setState] = useState<InfraState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchState = useCallback(async (refresh = false) => {
    try {
      const url = `${getBridgeUrl()}/infra/state${refresh ? "?refresh=true" : ""}`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: InfraState = await res.json();
      if (!mountedRef.current) return;
      setState(data);
      setError(null);
      setLoading(false);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e.message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchState();
    const interval = setInterval(() => fetchState(), POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchState]);

  const refresh = useCallback(() => fetchState(true), [fetchState]);

  return { state, loading, error, refresh };
}
