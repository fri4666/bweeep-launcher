export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

/** Launchers from 0.1.35 on send their version, so the server can tell old ones to update. */
export const LAUNCHER_VERSION_HEADER = "x-bweeep-launcher-version";
/** First launcher that joins servers through the Bweeep Yggdrasil API. */
export const MIN_YGGDRASIL_LAUNCHER = "0.1.35";

export function getLauncherVersion(request: Request): string | null {
  const value = request.headers.get(LAUNCHER_VERSION_HEADER)?.trim() ?? "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(value) ? value : null;
}

/** Compares the numeric release part; a missing version is older than everything. */
export function isLauncherAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const parts = (value: string) => value.split("-")[0].split(".").map(Number);
  const [a, b] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getSessionId(claims: Record<string, unknown> | undefined): string | null {
  const sessionId = claims?.session_id;
  return typeof sessionId === "string" && uuidPattern.test(sessionId) ? sessionId : null;
}
