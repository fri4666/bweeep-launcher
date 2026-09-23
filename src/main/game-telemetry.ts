import { StringDecoder } from "node:string_decoder";
import type { SyncProgress } from "../shared/types.js";

/** Summarize only recognizable Minecraft milestones; never forward raw game logs to the UI. */
export function createGameOutputObserver(progress: (event: SyncProgress) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lastMessage = "";
  return (chunk) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop()?.slice(-8192) ?? "";
    for (const line of lines) {
      const event = classifyGameLine(line);
      if (!event || event.message === lastMessage) continue;
      lastMessage = event.message;
      progress(event);
    }
  };
}

export function classifyGameLine(line: string): SyncProgress | null {
  const value = line.replace(/\u001b\[[0-9;]*m/g, "");
  if (value.includes("BWEEP_TARGET_JOINED")) {
    return { kind: "info", stage: "선택 서버 입장", message: "Minecraft 클라이언트에서 선택 서버 입장 신호 확인" };
  }
  if (value.includes("BWEEP_TARGET_LEFT")) {
    return { kind: "info", stage: "서버 연결 종료", message: "Minecraft 클라이언트에서 선택 서버 이탈 신호 확인" };
  }
  if (value.includes("BWEEP_TARGET_REJECTED")) {
    return { kind: "error", stage: "서버 접속 실패", message: "선택 서버가 연결을 거절했거나 연결에 실패했습니다. 서버 상태와 접속 인증을 확인해 주세요." };
  }
  const fabric = value.match(/Loading Minecraft ([\w.+-]+) with Fabric Loader ([\w.+-]+)/i);
  if (fabric) return { kind: "info", stage: "로더 초기화", message: `Minecraft ${fabric[1]} · Fabric ${fabric[2]} 초기화 중` };

  const mods = value.match(/Loading (\d+) mods\b/i);
  if (mods) return { kind: "info", stage: "모드 로딩", message: `Minecraft가 모드 ${mods[1]}개를 불러오는 중` };
  const script = value.match(/Loaded script (?:startup_scripts|client_scripts):([^\s]+) in /i);
  if (script) return { kind: "info", stage: "모드팩 스크립트", message: `게임 규칙 적용: ${script[1].slice(0, 80)}` };
  if (/ModLauncher.*starting|Forge Mod Loader.*loading/i.test(value)) {
    return { kind: "info", stage: "로더 초기화", message: "Forge 계열 모드 로더 초기화 중" };
  }
  if (/Reloading ResourceManager|Reloading resources/i.test(value)) {
    return { kind: "info", stage: "리소스 로딩", message: "리소스팩과 텍스처를 적용하는 중" };
  }
  if (/LWJGL Version|OpenAL initialized|Sound engine started/i.test(value)) {
    return { kind: "info", stage: "게임 초기화", message: "게임 창과 오디오 초기화 신호 감지" };
  }
  if (/Connecting to [^\s]+|Connecting to server/i.test(value)) {
    return { kind: "info", stage: "서버 연결", message: "Minecraft에서 서버 연결 시도 감지 · 참가 확인 전" };
  }
  if (/Logged in with entity id|Joining world/i.test(value)) {
    return { kind: "info", stage: "월드 로딩", message: "Minecraft에서 월드 입장 신호 감지 · 서버측 확인 전" };
  }
  if (/Connection lost|Disconnected from server/i.test(value)) {
    return { kind: "info", stage: "연결 종료", message: "Minecraft에서 서버 연결 종료 신호 감지" };
  }
  return null;
}
