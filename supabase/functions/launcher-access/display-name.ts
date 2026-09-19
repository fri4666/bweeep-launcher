const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}_ ]+$/u;

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/ +/g, " ");
  const length = Array.from(normalized).length;
  return length >= 2 && length <= 16 && DISPLAY_NAME_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function createDisplaySessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

export function isDisplaySessionToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
