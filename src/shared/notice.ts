/** The one announcement admins show to every member in the launcher. */
export interface LauncherNotice {
  id: string;
  text: string;
  /** When it was posted (ISO time). */
  at: string;
}

/** The limits launcher-access enforces (supabase/functions/launcher-access/notice.ts). */
export const MAX_NOTICE_LENGTH = 100;
export const MAX_NOTICE_LINES = 2;

/** Text as it will be stored: lines trimmed, empty ones dropped. */
export function tidyNoticeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

/** Why the text cannot be posted, or null when it can. */
export function noticeProblem(text: string): "empty" | "long" | "lines" | null {
  const tidy = tidyNoticeText(text);
  if (!tidy) return "empty";
  if ([...tidy].length > MAX_NOTICE_LENGTH) return "long";
  if (tidy.split("\n").length > MAX_NOTICE_LINES) return "lines";
  return null;
}

/** A notice as launcher-access returns it; null for none or anything malformed. */
export function parseNotice(value: unknown): LauncherNotice | null {
  if (!value || typeof value !== "object") return null;
  const { id, text, at } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (typeof text !== "string" || noticeProblem(text) !== null) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return { id, text: tidyNoticeText(text), at };
}
