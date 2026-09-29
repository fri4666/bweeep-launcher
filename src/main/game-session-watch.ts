import type { AuthFailure } from "../shared/admin-types.js";
import type { SyncProgress } from "../shared/types.js";

export interface GameSessionDeps {
  /** Moves the game token's expiry to twelve hours from now. */
  extend(accessToken: string): Promise<unknown>;
  /** The player's newest refusal since the given time, if any. */
  lastFailure(since: string): Promise<AuthFailure | null>;
  report(failure: AuthFailure): void;
  log(event: string, details: Record<string, unknown>): void;
  intervalMs?: number;
  /** A refusal is recorded right before the game shows it; a short wait covers the gap. */
  checkDelayMs?: number;
}

const HOUR_MS = 60 * 60_000;

/**
 * One game run's upkeep: the game token is extended every hour while the game
 * runs, and when the run failed to get into the server the player learns why.
 * A failed extension is only logged; the next hour tries again.
 */
export class GameSessionWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private token: string | null = null;
  private since = "";
  private joined = false;
  private run = 0;
  private reportedRun = 0;

  constructor(private readonly deps: GameSessionDeps) {}

  /** A token was issued for a new run. */
  started(accessToken: string, startedAt = Date.now()): void {
    this.stop();
    this.run += 1;
    this.token = accessToken;
    this.since = new Date(startedAt).toISOString();
    this.joined = false;
    this.timer = setInterval(() => void this.extend(), this.deps.intervalMs ?? HOUR_MS);
    this.timer.unref?.();
  }

  /** Game progress: joining the server, or the connection guard seeing a refusal. */
  observe(event: SyncProgress): void {
    if (!this.token) return;
    if (event.stage === "선택 서버 입장") this.joined = true;
    if (event.kind === "error" && event.stage === "서버 접속 실패") void this.checkFailure(this.deps.checkDelayMs ?? 1_500);
  }

  /** The game is gone. Nothing is shown when the player got into the server. */
  exited(): void {
    const checkNeeded = this.token !== null && !this.joined;
    this.stop();
    if (checkNeeded) void this.checkFailure(0);
  }

  /** The launch failed before the game ran. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.token = null;
  }

  private async extend(): Promise<void> {
    const token = this.token;
    if (!token) return;
    try {
      await this.deps.extend(token);
      this.deps.log("launch.token.extended", {});
    } catch (error) {
      this.deps.log("launch.token.extend-failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async checkFailure(delayMs: number): Promise<void> {
    const run = this.run;
    const since = this.since;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (run !== this.run || this.reportedRun === run) return;
    try {
      const failure = await this.deps.lastFailure(since);
      if (!failure || run !== this.run || this.reportedRun === run) return;
      this.reportedRun = run;
      this.deps.log("launch.auth.refused", { reason: failure.reason });
      this.deps.report(failure);
    } catch (error) {
      this.deps.log("launch.auth.refusal-check-failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
