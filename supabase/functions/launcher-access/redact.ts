// Masks values that look like credentials in log text before it is stored.
// The launcher masks the same shapes before sending (src/main/diagnostics.ts);
// this is the server's own pass for launchers that did not.

export const MAX_LOG_BYTES = 128 * 1024;

const MASK = "[가림]";

const patterns: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/(--(?:accessToken|clientToken)\s+)\S+/g, `$1${MASK}`],
  [/((?:access_?token|refresh_?token|client_?token|session_?token|display_?session_?token|ticket|api_?key|password|secret|provider_token)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{4,}/gi, `$1${MASK}`],
  [/([?&#](?:code|state|sb_flow_id|token|access_token|refresh_token|token_hash)=)[^&\s"']+/gi, `$1${MASK}`],
  [/BWEEP-[A-F0-9]{12}-[A-F0-9]{12}/gi, MASK],
  // Game tokens and tickets: 32 random bytes in base64url.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, (match) => /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match) ? MASK : match],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[메일]"],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, "$1[사용자]"]
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of patterns) {
    result = typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, replacement);
  }
  return result;
}

/** The last maxBytes of UTF-8 text, cut at a line start when one is near. */
export function tailBytes(text: string, maxBytes = MAX_LOG_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes)).replace(/^�+/, "");
  const lineStart = tail.indexOf("\n");
  return lineStart >= 0 && lineStart < 2048 ? tail.slice(lineStart + 1) : tail;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
