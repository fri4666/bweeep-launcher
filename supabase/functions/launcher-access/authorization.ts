export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getSessionId(claims: Record<string, unknown> | undefined): string | null {
  const sessionId = claims?.session_id;
  return typeof sessionId === "string" && uuidPattern.test(sessionId) ? sessionId : null;
}
