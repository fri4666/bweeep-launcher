// How the launcher says when a closed server opens. The gate decides when a
// server is open (scripts/server-gate.mjs); the launcher only shows its answer.

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/** "금 12:00": weekday and time in Korean time, whatever this PC's time zone is. */
export function formatOpenTime(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(epochMs);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return `${DAY_NAMES[day] ?? ""} ${get("hour")}:${get("minute")}`.trim();
}

/** The one line shown when Play is blocked. */
export function closedMessage(nextOpen: number): string {
  return `지금은 닫혀 있어요 · ${formatOpenTime(nextOpen)}에 열려요`;
}
