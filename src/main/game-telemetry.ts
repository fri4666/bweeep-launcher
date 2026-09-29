import { StringDecoder } from "node:string_decoder";
import type { SyncProgress } from "../shared/types.js";

/** Summarize only recognizable Minecraft milestones; never forward raw game logs to the UI. */
export function createGameOutputObserver(progress: (event: SyncProgress) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lastEvent = "";
  let disconnectReason: string | null = null;
  return (chunk) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop()?.slice(-8192) ?? "";
    for (const line of lines) {
      if (line.includes("BWEEP_TARGET_CONNECTED")) disconnectReason = null;
      disconnectReason = parseDisconnectReason(line) ?? disconnectReason;
      const event = line.includes("BWEEP_EXIT_ON_LEAVE") ? leaveEvent(disconnectReason) : classifyGameLine(line);
      const key = event ? `${event.stage}|${event.message}` : "";
      if (!event || key === lastEvent) continue;
      lastEvent = key;
      progress(event);
    }
  };
}

// Logged when the connection ends from the server's side or the network
// (kick, shutdown, timeout), in the game's language. Older versions log nothing.
const DISCONNECT_REASON = /Client disconnected with reason: (.+)$/;
// Leaving by choice, in case a version logs it too.
const QUIT_REASONS = new Set(["quitting", "종료 중", "multiplayer.status.quitting"]);

function parseDisconnectReason(line: string): string | null {
  const match = DISCONNECT_REASON.exec(line.replace(/\u001b\[[0-9;]*m/g, ""));
  const reason = match?.[1].replace(/§./g, "").replace(/\s+/g, " ").trim();
  return reason || null;
}

/** The guard ended the game after it left the server. Only a reason the game logged is shown. */
function leaveEvent(reason: string | null): SyncProgress {
  if (!reason || QUIT_REASONS.has(reason.toLowerCase())) return { kind: "info", stage: "서버 연결 종료", message: "게임 끔" };
  return { kind: "error", stage: "서버 연결 끊김", message: reason.length > 60 ? `${reason.slice(0, 59)}…` : reason };
}

// The stage is the heading on screen, so each message only adds a word or two.
function classifyGameLine(line: string): SyncProgress | null {
  const value = line.replace(/\u001b\[[0-9;]*m/g, "");
  // Lines from the connection guard agent, the same on every version and loader.
  if (value.includes("BWEEP_TARGET_CONNECTED")) {
    return { kind: "info", stage: "선택 서버 입장", message: "접속됨" };
  }
  if (value.includes("BWEEP_TARGET_DISCONNECTED")) {
    return { kind: "info", stage: "서버 연결 종료", message: "연결 끊김" };
  }
  if (value.includes("BWEEP_TARGET_UNREACHABLE")) {
    return { kind: "error", stage: "서버 접속 실패", message: "서버에 연결하지 못했어요" };
  }
  if (value.includes("BWEEP_GUARD_BLOCKED")) {
    return { kind: "info", stage: "다른 서버 차단", message: "고른 서버만 접속돼요" };
  }
  if (value.includes("BWEEP_GUARD_DISABLED")) {
    return { kind: "info", stage: "서버 연결 보호", message: "이 버전은 지원 안 됨" };
  }
  if (value.includes("BWEEP_TARGET_JOINED")) {
    return { kind: "info", stage: "선택 서버 입장", message: "접속됨" };
  }
  if (value.includes("BWEEP_TARGET_LEFT")) {
    return { kind: "info", stage: "서버 연결 종료", message: "나옴" };
  }
  if (value.includes("BWEEP_TARGET_REJECTED")) {
    return { kind: "error", stage: "서버 접속 실패", message: "서버가 접속을 거절했어요" };
  }
  const fabric = value.match(/Loading Minecraft ([\w.+-]+) with Fabric Loader ([\w.+-]+)/i);
  if (fabric) return { kind: "info", stage: "로더 초기화", message: `Fabric ${fabric[2]}` };

  const mods = value.match(/Loading (\d+) mods\b/i);
  if (mods) return { kind: "info", stage: "모드 로딩", message: `모드 ${mods[1]}개` };
  const script = value.match(/Loaded script (?:startup_scripts|client_scripts):([^\s]+) in /i);
  if (script) return { kind: "info", stage: "모드팩 스크립트", message: script[1].slice(0, 60) };
  if (/ModLauncher.*starting|Forge Mod Loader.*loading/i.test(value)) {
    return { kind: "info", stage: "로더 초기화", message: "Forge" };
  }
  if (/Reloading ResourceManager|Reloading resources/i.test(value)) {
    return { kind: "info", stage: "리소스 로딩", message: "리소스 적용 중" };
  }
  if (/LWJGL Version|OpenAL initialized|Sound engine started/i.test(value)) {
    return { kind: "info", stage: "게임 초기화", message: "창과 소리 준비 중" };
  }
  if (/Connecting to [^\s]+|Connecting to server/i.test(value)) {
    return { kind: "info", stage: "서버 연결", message: "연결 중" };
  }
  if (/Logged in with entity id|Joining world/i.test(value)) {
    return { kind: "info", stage: "월드 로딩", message: "월드 불러오는 중" };
  }
  if (/Connection lost|Disconnected from server/i.test(value)) {
    return { kind: "info", stage: "연결 종료", message: "연결 끊김" };
  }
  return null;
}
