import type { createClient } from "@supabase/supabase-js";
import { byteLength, MAX_LOG_BYTES, redactSecrets, tailBytes } from "./redact.ts";

type Db = ReturnType<typeof createClient<any, "public">>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export function isDiagnosticsLog(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= MAX_LOG_BYTES;
}

/** One text file for admins: who sent it, then both log tails with credentials masked. */
export function composeDiagnostics(input: { userId: string; launcherVersion: string | null; gameLog: string; launcherLog: string; sentAt: Date }): string {
  const section = (title: string, text: string) => `===== ${title} =====\n${tailBytes(redactSecrets(text)) || "(없음)"}\n`;
  return [
    "Bweeep 진단 정보",
    `멤버: ${input.userId}`,
    `런처: ${input.launcherVersion ?? "알 수 없음"}`,
    `보낸 시각: ${input.sentAt.toISOString()}`,
    "",
    section("게임 로그 끝부분", input.gameLog),
    section("런처 로그 끝부분", input.launcherLog)
  ].join("\n");
}

export async function uploadDiagnostics(
  db: Db,
  userId: string,
  launcherVersion: string | null,
  logs: { gameLog: string; launcherLog: string }
): Promise<Response> {
  const text = composeDiagnostics({ userId, launcherVersion, ...logs, sentAt: new Date() });
  const { data, error } = await db.rpc("launcher_begin_diagnostics", { p_user_id: userId, p_size_bytes: byteLength(text) });
  if (error?.message === "DIAGNOSTICS_RATE_LIMITED") {
    return json({ code: "DIAGNOSTICS_RATE_LIMITED", message: "진단 정보는 10분에 한 번만 보낼 수 있어요." }, 429);
  }
  const started = data?.[0] as { diagnostic_id: string; expired_ids: string[] } | undefined;
  if (error || !started) {
    console.error("diagnostics start failed", error);
    return json({ message: "진단 정보를 보내지 못했습니다." }, 500);
  }
  const bucket = db.storage.from("launcher-diagnostics");
  if (started.expired_ids.length > 0) {
    const { error: removeError } = await bucket.remove(started.expired_ids.map((id) => `${id}.txt`));
    if (removeError) console.error("expired diagnostics removal failed", removeError);
  }
  const { error: uploadError } = await bucket.upload(`${started.diagnostic_id}.txt`, new Blob([text], { type: "text/plain" }), {
    contentType: "text/plain",
    upsert: false
  });
  if (uploadError) {
    console.error("diagnostics upload failed", uploadError);
    await db.from("launcher_diagnostics").delete().eq("id", started.diagnostic_id);
    return json({ message: "진단 정보를 보내지 못했습니다." }, 500);
  }
  return json({ ok: true });
}
