import type { ServerPreset, ServerStatus } from "../shared/types.js";
import { formatOpenTime } from "../shared/open-hours.js";
import "./play.css";

export type ServerState = "catalogError" | "loading" | "checking" | "online" | "sleeping" | "starting" | "closed" | "offline";

export function serverState(catalogState: "loading" | "ready" | "error", server: ServerPreset | undefined, status: ServerStatus | undefined): ServerState {
  if (catalogState === "error") return "catalogError";
  if (catalogState === "loading" || !server) return "loading";
  if (!status) return "checking";
  return statusState(status);
}

function statusState(status: ServerStatus): "online" | "sleeping" | "starting" | "closed" | "offline" {
  if (!status.online) return "offline";
  if (status.closed) return "closed";
  return status.sleep ?? "online";
}

/** The server rail carries only the connection summary for each server. */
export function ServerConnectionBadge({ status }: { status: ServerStatus | undefined }) {
  const state = status ? statusState(status) : "checking";
  const text = state === "online" ? status?.players ? `${status.players.online}명 접속 중` : "접속 가능"
    : state === "sleeping" ? "대기 중" : state === "starting" ? "시작 중"
    : state === "closed" && status?.closed ? `${formatOpenTime(status.closed.nextOpen)} 열림`
    : state === "offline" ? "오프라인" : "상태 확인 중";
  return <span className={`libraryConnection is-${state}`} title={text}><i className="statusDot" aria-hidden="true" />{text}</span>;
}

/** Shown on the launch button when the selected server is off. */
export function ServerOffIcon() {
  return (
    <svg className="launchOffIcon" viewBox="0 0 24 24" role="img" aria-label="서버 꺼짐">
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
