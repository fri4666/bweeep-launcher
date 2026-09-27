export interface GameExitResult {
  abnormal: boolean;
  message: string;
  code: number | null;
  signal: string | null;
  crashReportLocation: string | null;
}

export function describeGameExit(exit: {
  code?: number | null;
  signal?: string | null;
  crashReport?: string;
  crashReportLocation?: string;
}): GameExitResult {
  const code = typeof exit.code === "number" ? exit.code : null;
  const signal = exit.signal || null;
  const crashReportLocation = exit.crashReportLocation?.trim() || null;
  const detail = signal ? `신호 ${signal}` : code !== null ? `코드 ${code}` : "종료 코드 없음";
  const abnormal = Boolean(signal || exit.crashReport || crashReportLocation || code !== 0);
  return {
    abnormal,
    message: abnormal
      ? `게임이 예기치 않게 꺼졌습니다. 다시 시작해 보고, 계속되면 로그를 확인해 주세요. (${detail})`
      : "Minecraft가 종료되었습니다.",
    code,
    signal,
    crashReportLocation
  };
}
