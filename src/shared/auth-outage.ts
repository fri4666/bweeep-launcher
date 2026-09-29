import type { AuthOutage } from "./types.js";

/** One line each; the renderer matches them to show a launch refusal as a single line. */
export const authOutageMessages: Record<AuthOutage, string> = {
  auth: "인증 서버 점검 중이라 지금은 못 들어가요",
  network: "인터넷이 끊겨서 지금은 못 들어가요"
};

export function authOutageFromMessage(message: string): AuthOutage | null {
  if (message === authOutageMessages.auth) return "auth";
  if (message === authOutageMessages.network) return "network";
  return null;
}

/**
 * launcher-access answered with a gateway or platform error (it is down or
 * overloaded), or nothing answered at all (status 0). A 500 that carries the
 * function's own message is an ordinary failure, not an outage.
 */
export function isAuthOutageResponse(status: number, hasMessage: boolean): boolean {
  if (status === 0) return true;
  if (status === 502 || status === 503 || status === 504) return true;
  return status >= 500 && !hasMessage;
}

/**
 * Whose fault it is when launcher-access did not answer. Any HTTP status
 * means Supabase was reached; otherwise a game server that still answers
 * means this PC is online.
 */
export function classifyAuthOutage(probe: { status: number; systemOnline: boolean; gameServerReachable: boolean }): AuthOutage {
  if (probe.status !== 0) return "auth";
  if (!probe.systemOnline) return "network";
  return probe.gameServerReachable ? "auth" : "network";
}
