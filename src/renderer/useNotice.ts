import { useCallback, useEffect, useRef, useState } from "react";
import type { LauncherNotice } from "../shared/notice.js";

const POLL_MS = 5 * 60_000;
/** Coming back to the window checks again, but not more often than this. */
const MIN_GAP_MS = 60_000;
const dismissedStorageKey = "bweeep.notice-dismissed-id";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(dismissedStorageKey);
  } catch {
    return null;
  }
}

export interface NoticeState {
  /** The notice admins show now, closed or not. */
  current: LauncherNotice | null;
  /** The notice to show on the main screen: the current one unless this member closed it. */
  shown: LauncherNotice | null;
  dismiss: () => void;
  /** After an admin posted or took one down here, without waiting for the next check. */
  replace: (notice: LauncherNotice | null) => void;
}

/**
 * The admins' notice, checked at start, every five minutes and when the
 * window comes back; hidden, nothing is sent. A failed check keeps the last
 * notice. Closing one hides it on this PC until a new one is posted.
 */
export function useNotice(enabled: boolean): NoticeState {
  const [current, setCurrent] = useState<LauncherNotice | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(readDismissed);
  const checkedAt = useRef(0);
  const inFlight = useRef(false);

  const check = useCallback(async (force: boolean) => {
    if (inFlight.current || document.visibilityState === "hidden") return;
    if (!force && Date.now() - checkedAt.current < MIN_GAP_MS) return;
    inFlight.current = true;
    try {
      setCurrent(await window.bweeep.notice());
      checkedAt.current = Date.now();
    } catch {
      // Offline or an older server: nothing new to show.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setCurrent(null);
      return;
    }
    void check(true);
    const timer = window.setInterval(() => void check(true), POLL_MS);
    const onVisible = () => void check(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, check]);

  const dismiss = useCallback(() => {
    if (!current) return;
    setDismissedId(current.id);
    try {
      window.localStorage.setItem(dismissedStorageKey, current.id);
    } catch {
      // Closed for this run only.
    }
  }, [current]);

  return { current, shown: current && current.id !== dismissedId ? current : null, dismiss, replace: setCurrent };
}
