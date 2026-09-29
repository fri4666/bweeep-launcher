/**
 * Name rule (see migration 20260929120000_relax_name_lock.sql): another
 * member's current name is taken, and a name someone actually played under
 * stays theirs for one day after they switch away from it.
 */
export function gameNameTakenMessage(gameName: string): string {
  return `'${gameName}'은(는) 다른 멤버가 쓰고 있거나 하루 안에 쓴 이름이에요.`;
}

/** The name functions raise GAME_NAME_TAKEN; anything else is a real failure. */
export function isGameNameTaken(error: { message?: string } | null | undefined): boolean {
  return error?.message === "GAME_NAME_TAKEN";
}

/** Offline-mode servers are no longer served; the admin has to switch the pack to Bweeep accounts. */
export const OFFLINE_SERVER = {
  code: "SERVER_AUTH_UNSUPPORTED",
  message: "이 서버는 붸에엡 계정 접속으로 바뀌기 전까지 열 수 없어요."
};
