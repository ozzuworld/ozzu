import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  type Connection,
  type HassEntities,
  subscribeEntities,
  callService as haCallService,
} from "home-assistant-js-websocket";
import { connectToHA } from "./ha-connection";
import { HA_TOKEN } from "./config";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface HAContextValue {
  entities: HassEntities;
  status: ConnectionStatus;
  callService: (
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: { entity_id: string | string[] }
  ) => Promise<void>;
}

const HAContext = createContext<HAContextValue>({
  entities: {},
  status: "disconnected",
  callService: async () => {},
});

export function HAProvider({ children }: { children: React.ReactNode }) {
  const [entities, setEntities] = useState<HassEntities>({});
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    if (!HA_TOKEN) {
      setStatus("disconnected");
      return;
    }

    let unsub: (() => void) | undefined;
    let cancelled = false;

    async function connect() {
      let delay = 2000;
      const MAX_DELAY = 30000;

      while (!cancelled) {
        setStatus("connecting");
        try {
          const conn = await connectToHA();
          if (cancelled) {
            conn.close();
            return;
          }
          connectionRef.current = conn;
          setStatus("connected");

          conn.addEventListener("disconnected", () => {
            if (!cancelled) setStatus("disconnected");
          });
          conn.addEventListener("ready", () => {
            if (!cancelled) setStatus("connected");
          });

          unsub = subscribeEntities(conn, (ents) => {
            if (!cancelled) setEntities(ents);
          });
          return;
        } catch (err) {
          console.error("HA connection error:", err);
          if (cancelled) return;
          setStatus("error");
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, MAX_DELAY);
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      unsub?.();
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, []);

  const callService = useCallback(
    async (
      domain: string,
      service: string,
      data?: Record<string, unknown>,
      target?: { entity_id: string | string[] }
    ) => {
      const conn = connectionRef.current;
      if (!conn) return;
      await haCallService(conn, domain, service, data, target);
    },
    []
  );

  return (
    <HAContext.Provider value={{ entities, status, callService }}>
      {children}
    </HAContext.Provider>
  );
}

export function useHA() {
  return useContext(HAContext);
}
