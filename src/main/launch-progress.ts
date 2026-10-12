import type { SyncProgress } from "../shared/types.js";

/**
 * The launch screen shows only the last progress event, so two jobs that run
 * side by side would make its title and bar flicker between them. One job is
 * shown (the foreground); the other (the background lane) is only written to
 * the launch log until the foreground one is done, then its latest state takes
 * over. Errors always get through.
 */
export interface BackgroundLane {
  /** Progress sink for the background job. */
  sink: (event: SyncProgress) => void;
  /** The foreground job finished: show what the background job is doing from now on. */
  surface(): void;
  /** The launch failed: nothing more from the background job reaches the screen. */
  silence(): void;
}

/**
 * Starts the pack sync and the game-file preparation together. `ready` settles
 * with the sync result once both are done and fails as soon as either fails;
 * the other one is then still running, which `settled()` waits out (the next
 * launch does, so two runs never write the same files).
 */
export function startBesideSync<S, P>(
  lane: BackgroundLane,
  sync: () => Promise<S>,
  prepare: () => Promise<P>
): { ready: Promise<S>; preparing: Promise<P>; settled: () => Promise<void> } {
  const syncing = sync();
  const preparing = prepare();
  // The screen switches to the game files once the pack is in.
  void syncing.then(() => lane.surface(), () => undefined);
  const ready = Promise.all([syncing, preparing]).then(([synced]) => synced);
  return {
    ready,
    preparing,
    settled: () => Promise.allSettled([syncing, preparing]).then(() => undefined)
  };
}

export function createBackgroundLane(forward: (event: SyncProgress) => void, record: (event: SyncProgress) => void): BackgroundLane {
  let surfaced = false;
  let silenced = false;
  let latest: SyncProgress | null = null;
  return {
    sink(event) {
      if (silenced) {
        record(event);
        return;
      }
      if (surfaced || event.kind === "error") {
        forward(event);
        return;
      }
      latest = event;
      record(event);
    },
    surface() {
      if (surfaced || silenced) return;
      surfaced = true;
      if (latest) forward(latest);
      latest = null;
    },
    silence() {
      silenced = true;
      latest = null;
    }
  };
}
