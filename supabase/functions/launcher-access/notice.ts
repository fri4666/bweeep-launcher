import type { createClient } from "@supabase/supabase-js";

type Db = ReturnType<typeof createClient<any, "public">>;

/** The announcement shown to every member in the launcher. */
export interface LauncherNotice {
  id: string;
  text: string;
  at: string;
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

export function toNotice(row: { id: string; body: string; created_at: string } | null | undefined): LauncherNotice | null {
  return row ? { id: row.id, text: row.body, at: row.created_at } : null;
}

/** The notice shown now, or null. Throws when it cannot be read. */
export async function currentNotice(db: Db): Promise<LauncherNotice | null> {
  const { data, error } = await db.from("launcher_notices").select("id, body, created_at").is("ended_at", null).maybeSingle();
  if (error) throw new Error(`notice read failed: ${error.message}`);
  return toNotice(data);
}
