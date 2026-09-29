export function createGameTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isGameName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
}

/**
 * A ticket only vouches for the name this member actually plays under (the
 * same name the launcher derives), and only while no other member owns it;
 * otherwise a member could ask for a ticket in someone else's name.
 */
export function ticketNameProblem(requested: string, expected: string, available: boolean): { code: string; message: string } | null {
  if (requested !== expected) {
    return { code: "GAME_NAME_MISMATCH", message: "인게임 이름이 바뀌었어요. 런처를 다시 켠 뒤 시작해 주세요." };
  }
  if (!available) {
    return { code: "GAME_NAME_TAKEN", message: `'${expected}'은(는) 다른 멤버의 이름이라 쓸 수 없어요. 계정 설정에서 인게임 이름을 바꿔 주세요.` };
  }
  return null;
}

export function isGameTicket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
