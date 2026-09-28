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
  const detail = signal ? `신호 ${signal}` : code !== null ? `코드 ${formatExitCode(code)}` : "종료 코드 없음";
  const abnormal = Boolean(signal || exit.crashReport || crashReportLocation || code !== 0);
  return {
    abnormal,
    message: abnormal
      ? `비정상 종료 (${detail})`
      : "Minecraft가 종료되었습니다.",
    code,
    signal,
    crashReportLocation
  };
}

// Windows reports killed or crashed processes as large unsigned values
// (4294967295, 3221225477); hex matches how those codes are documented.
function formatExitCode(code: number): string {
  if (code >= 0x80000000 && code <= 0xffffffff) return `0x${code.toString(16).toUpperCase()}`;
  return String(code);
}
