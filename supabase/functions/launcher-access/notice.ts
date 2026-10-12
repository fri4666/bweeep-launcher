import type { createClient } from "@supabase/supabase-js";

type Db = ReturnType<typeof createClient<any, "public">>;

/** The announcement shown in the launcher: to every member, or to one member only. */
export interface LauncherNotice {
  id: string;
  text: string;
  at: string;
  /** Only present, and true, for a notice meant for this member alone. */
  personal?: true;
}

/** Short enough to fit above the server name in the smallest launcher window. */
export const MAX_NOTICE_LENGTH = 100;

/**
 * What an admin typed, as it is stored: line ends unified, spaces at the ends
 * removed and at most two lines. Null when it is empty, too long or holds
 * control characters.
 */
export function normalizeNoticeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  // deno-lint-ignore no-control-regex
  if (!text || [...text].length > MAX_NOTICE_LENGTH || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return null;
  if (text.split("\n").length > 2) return null;
  return text;
}

export interface NoticeRow {
  id: string;
  body: string;
  created_at: string;
  /** Null for the notice everyone sees. */
  target_user_id?: string | null;
}

export function toNotice(row: NoticeRow | null | undefined): LauncherNotice | null {
  if (!row) return null;
  return row.target_user_id
    ? { id: row.id, text: row.body, at: row.created_at, personal: true }
    : { id: row.id, text: row.body, at: row.created_at };
}

/**
 * What one member is shown: their own notice if there is one, otherwise the
 * everyone-notice. Another member's personal notice is never returned, whatever
 * the rows hold.
 */
export function pickNotice(rows: readonly NoticeRow[], userId: string): LauncherNotice | null {
  const own = rows.find((row) => row.target_user_id === userId);
  const everyone = rows.find((row) => !row.target_user_id);
  return toNotice(own ?? everyone);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The notice this member is shown now, or null. Throws when it cannot be read. */
export async function currentNotice(db: Db, userId: string): Promise<LauncherNotice | null> {
  let query = db.from("launcher_notices").select("id, body, created_at, target_user_id").is("ended_at", null);
  // The id comes from the verified session; the pattern only keeps the filter text well-formed.
  if (uuidPattern.test(userId)) query = query.or(`target_user_id.is.null,target_user_id.eq.${userId}`);
  else query = query.is("target_user_id", null);
  const { data, error } = await query;
  if (error) throw new Error(`notice read failed: ${error.message}`);
  return pickNotice((data ?? []) as NoticeRow[], userId);
}
