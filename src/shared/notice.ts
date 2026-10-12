/** The announcement admins show in the launcher: to every member, or to this member only. */
export interface LauncherNotice {
  id: string;
  text: string;
  /** When it was posted (ISO time). */
  at: string;
  /** True for a notice posted for this member alone. */
  personal?: true;
}

/** A notice as the admin tab lists it; `target` is null for the one everyone sees. */
export interface AdminNotice {
  id: string;
  text: string;
  at: string;
  target: { userId: string; name: string; gameName: string | null } | null;
}

/** What posting or taking down a notice answers: the admin's own notice, and every notice shown now. */
export interface NoticeUpdate {
  notice: LauncherNotice | null;
  notices: AdminNotice[];
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
  const { id, text, at, personal } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (typeof text !== "string" || noticeProblem(text) !== null) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return personal === true ? { id, text: tidyNoticeText(text), at, personal: true } : { id, text: tidyNoticeText(text), at };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One entry of the admin list; null for anything malformed. */
export function parseAdminNotice(value: unknown): AdminNotice | null {
  const base = parseNotice(value);
  if (!base) return null;
  const target = (value as { target?: unknown }).target;
  if (target === null || target === undefined) return { id: base.id, text: base.text, at: base.at, target: null };
  if (typeof target !== "object") return null;
  const { userId, name, gameName } = target as Record<string, unknown>;
  if (typeof userId !== "string" || !UUID.test(userId) || typeof name !== "string") return null;
  return { id: base.id, text: base.text, at: base.at, target: { userId, name, gameName: typeof gameName === "string" ? gameName : null } };
}

/** The admin list, with anything malformed left out. */
export function parseAdminNotices(value: unknown): AdminNotice[] {
  return Array.isArray(value) ? value.map(parseAdminNotice).filter((notice): notice is AdminNotice => notice !== null) : [];
}
