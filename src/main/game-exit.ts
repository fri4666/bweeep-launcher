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
      ? `Minecraft가 비정상 종료되었습니다. (${detail}) 게임 폴더의 logs/latest.log를 확인하세요.`
      : "Minecraft가 종료되었습니다.",
    code,
    signal,
    crashReportLocation
  };
}
