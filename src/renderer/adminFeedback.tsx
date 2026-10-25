import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the green check stays after an action worked. */
export const DONE_VISIBLE_MS = 2500;

export interface Feedback {
  text: string;
  error: boolean;
}

/** The text of a failed call without Electron's "Error invoking remote method" prefix. */
export function errorText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") || fallback;
}

/**
 * One mechanism for every admin request: `key` names the row or panel the
 * request belongs to. While it runs that key is `busy`; when it worked the key
 * is `doneKey` for a moment and the toast says what happened; when it failed
 * the toast stays, in red, until the next action or until it is closed.
 */
export function useActionFeedback() {
  const [busy, setBusy] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const timer = useRef<number | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stopTimer, []);

  /** Closes whatever is shown, e.g. when the admin switches tab. */
  const clear = useCallback(() => {
    stopTimer();
    setDoneKey(null);
    setFeedback(null);
  }, []);

  const fail = useCallback((error: unknown, fallback: string) => {
    stopTimer();
    setDoneKey(null);
    setFeedback({ text: errorText(error, fallback), error: true });
  }, []);

  const run = useCallback(async <T,>(key: string, action: () => Promise<T>, apply: (value: T) => void, done: string, fallback: string) => {
    stopTimer();
    setBusy(key);
    setDoneKey(null);
    setFeedback(null);
    try {
      apply(await action());
      setDoneKey(key);
      setFeedback({ text: done, error: false });
      timer.current = window.setTimeout(() => {
        setDoneKey(null);
        setFeedback((current) => (current && !current.error ? null : current));
      }, DONE_VISIBLE_MS);
    } catch (error) {
      setFeedback({ text: errorText(error, fallback), error: true });
    } finally {
      setBusy(null);
    }
  }, []);

  /** Class names that show a row or panel as running or just done. */
  const stateClass = (key: string) => (busy === key ? " isBusy" : doneKey === key ? " isDone" : "");

  return { busy, doneKey, feedback, run, fail, clear, stateClass };
}

const iconProps = { viewBox: "0 0 24 24", "aria-hidden": true as const };

export function CheckIcon() {
  return <svg {...iconProps}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

function CrossIcon() {
  return <svg {...iconProps}><path d="M7 7l10 10M17 7L7 17" /></svg>;
}

/** The small mark at the end of a row: a spinner while it runs, a green check once it worked. */
export function ActionMark({ state }: { state: "busy" | "done" | null }) {
  if (!state) return null;
  return state === "busy"
    ? <span className="adminMark isBusy" aria-hidden="true"><span className="spinner" /></span>
    : <span className="adminMark isDone" aria-hidden="true"><CheckIcon /></span>;
}

/** Shown over the bottom of the panel so nothing moves when it appears. */
export function FeedbackToast({ feedback, onClose, host }: { feedback: Feedback | null; onClose: () => void; host?: HTMLElement | null }) {
  const toast = (
    <div className="adminToastSlot" aria-live="polite">
      {feedback && (
        <div className={`adminToast${feedback.error ? " isError" : " isOk"}`} role={feedback.error ? "alert" : "status"}>
          {feedback.error ? <CrossIcon /> : <CheckIcon />}
          <span>{feedback.text}</span>
          {feedback.error && <button className="adminToastClose" aria-label="닫기" onClick={onClose}><CrossIcon /></button>}
        </div>
      )}
    </div>
  );
  return host ? createPortal(toast, host) : toast;
}
