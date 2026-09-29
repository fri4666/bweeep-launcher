import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerPreset, ServerStatus } from "../shared/types.js";

const POLL_MS = 10_000;

export interface ServerStatuses {
  /** Last status of each server, by server id. */
  byId: Record<string, ServerStatus>;
  checkedAt: number | null;
  checking: boolean;
  refresh: () => void;
}

/**
 * Every listed server, checked together every 10 seconds while the window is
 * visible; minimized or hidden, nothing is sent. A round still running is
 * never started again.
 */
export function useServerStatuses(servers: ServerPreset[]): ServerStatuses {
  const [byId, setById] = useState<Record<string, ServerStatus>>({});
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const listKey = servers.map((server) => `${server.id}@${server.server.host}:${server.server.port}`).join(",");

  const check = useCallback(async () => {
    const list = serversRef.current;
    if (inFlight.current || list.length === 0 || document.visibilityState === "hidden") return;
    inFlight.current = true;
    setChecking(true);
    try {
      const results = await Promise.all(list.map(async (server): Promise<[string, ServerStatus]> => {
        try {
          return [server.id, await window.bweeep.serverStatus(server.server)];
        } catch {
          return [server.id, { online: false, host: server.server.host, port: server.server.port, message: "연결 끊김" }];
        }
      }));
      setById(Object.fromEntries(results));
      setCheckedAt(Date.now());
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!listKey) return;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState === "hidden") return;
      void check();
      timer = window.setInterval(() => void check(), POLL_MS);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [listKey, check]);

  return { byId, checkedAt, checking, refresh: () => void check() };
}

/**
 * Servers the player already agreed to start while they were off. The
 * question is asked once per server until it is seen online again.
 */
export function useOfflineLaunchConsent(byId: Record<string, ServerStatus>) {
  const consented = useRef(new Set<string>());
  useEffect(() => {
    for (const [id, status] of Object.entries(byId)) if (status.online) consented.current.delete(id);
  }, [byId]);
  return {
    given: (id: string) => consented.current.has(id),
    give: (id: string) => void consented.current.add(id)
  };
}
