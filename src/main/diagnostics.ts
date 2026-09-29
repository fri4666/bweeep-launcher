import fsp from "node:fs/promises";

/** Each log sent to admins is at most this long; the server refuses more. */
export const MAX_DIAGNOSTIC_LOG_BYTES = 128 * 1024;

const MASK = "[가림]";

// Same shapes as supabase/functions/launcher-access/redact.ts, which masks
// again on the server.
const patterns: Array<[RegExp, string | ((match: string) => string)]> = [
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
export function tailText(text: string, maxBytes = MAX_DIAGNOSTIC_LOG_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const tail = bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^�+/, "");
  const lineStart = tail.indexOf("\n");
  const cut = lineStart >= 0 && lineStart < 2048 ? tail.slice(lineStart + 1) : tail;
  // A replacement character at the cut can make the text a few bytes longer again.
  return Buffer.byteLength(cut, "utf8") <= maxBytes ? cut : tailText(cut.slice(1), maxBytes);
}

/** Only a signed Storage address of the diagnostics bucket is opened in the browser. */
export function isDiagnosticsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.pathname.startsWith("/storage/v1/object/sign/launcher-diagnostics/") && url.searchParams.has("token");
  } catch {
    return false;
  }
}

/** Reads only the end of a log file, masked, so a huge log never loads whole. */
export async function readLogTail(file: string | null, maxBytes = MAX_DIAGNOSTIC_LOG_BYTES): Promise<string> {
  if (!file) return "";
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes * 2);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return tailText(redactSecrets(buffer.toString("utf8")), maxBytes);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}
