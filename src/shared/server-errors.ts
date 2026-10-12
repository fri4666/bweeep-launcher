/**
 * What launcher-access answers (HTTP 400) to an action it does not know, which
 * is what a launcher newer than the deployed function gets.
 */
const UNKNOWN_ACTION_MESSAGE = "지원하지 않는 요청입니다.";

/** The one line the player or admin reads instead. */
export const SERVER_LACKS_FEATURE_TEXT = "서버가 아직 이 기능을 지원하지 않아요.";

export function isUnknownActionResponse(status: number, message: unknown): boolean {
  return status === 400 && typeof message === "string" && message.trim() === UNKNOWN_ACTION_MESSAGE;
}

/** The message to show for a function reply: a known-missing feature gets the short line, anything else passes through. */
export function describeServerMessage(status: number, message: string): string {
  return isUnknownActionResponse(status, message) ? SERVER_LACKS_FEATURE_TEXT : message;
}
