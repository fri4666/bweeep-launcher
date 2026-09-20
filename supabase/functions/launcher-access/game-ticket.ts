export function createGameTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isGameName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
}

export function isGameTicket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
