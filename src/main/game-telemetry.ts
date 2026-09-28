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

function classifyGameLine(line: string): SyncProgress | null {
  const value = line.replace(/\u001b\[[0-9;]*m/g, "");
  // Lines from the connection guard agent, the same on every version and loader.
  if (value.includes("BWEEP_TARGET_CONNECTED")) {
    return { kind: "info", stage: "선택 서버 입장", message: "서버에 연결했습니다" };
  }
  if (value.includes("BWEEP_TARGET_DISCONNECTED")) {
    return { kind: "info", stage: "서버 연결 종료", message: "서버와 연결이 끊겼습니다" };
  }
  if (value.includes("BWEEP_TARGET_UNREACHABLE")) {
    return { kind: "error", stage: "서버 접속 실패", message: "서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인한 뒤 다시 시도해 주세요." };
  }
  if (value.includes("BWEEP_GUARD_BLOCKED")) {
    return { kind: "info", stage: "다른 서버 차단", message: "붸에엡 런처로 실행한 게임은 선택한 서버에만 접속할 수 있습니다" };
  }
  if (value.includes("BWEEP_GUARD_DISABLED")) {
    return { kind: "info", stage: "서버 연결 보호", message: "이 게임 버전에서는 연결 보호를 켜지 못했습니다" };
  }
  if (value.includes("BWEEP_TARGET_JOINED")) {
    return { kind: "info", stage: "선택 서버 입장", message: "서버에 접속했습니다" };
  }
  if (value.includes("BWEEP_TARGET_LEFT")) {
    return { kind: "info", stage: "서버 연결 종료", message: "서버에서 나왔습니다" };
  }
  if (value.includes("BWEEP_TARGET_REJECTED")) {
    return { kind: "error", stage: "서버 접속 실패", message: "서버가 연결을 거절했거나 연결에 실패했습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요." };
  }
  const fabric = value.match(/Loading Minecraft ([\w.+-]+) with Fabric Loader ([\w.+-]+)/i);
  if (fabric) return { kind: "info", stage: "로더 초기화", message: `Fabric ${fabric[2]} 로더 준비 중` };

  const mods = value.match(/Loading (\d+) mods\b/i);
  if (mods) return { kind: "info", stage: "모드 로딩", message: `모드 ${mods[1]}개 불러오는 중` };
  const script = value.match(/Loaded script (?:startup_scripts|client_scripts):([^\s]+) in /i);
  if (script) return { kind: "info", stage: "모드팩 스크립트", message: `게임 규칙 적용: ${script[1].slice(0, 80)}` };
  if (/ModLauncher.*starting|Forge Mod Loader.*loading/i.test(value)) {
    return { kind: "info", stage: "로더 초기화", message: "Forge 로더 준비 중" };
  }
  if (/Reloading ResourceManager|Reloading resources/i.test(value)) {
    return { kind: "info", stage: "리소스 로딩", message: "리소스팩과 텍스처 적용 중" };
  }
  if (/LWJGL Version|OpenAL initialized|Sound engine started/i.test(value)) {
    return { kind: "info", stage: "게임 초기화", message: "게임 창과 소리 준비 중" };
  }
  if (/Connecting to [^\s]+|Connecting to server/i.test(value)) {
    return { kind: "info", stage: "서버 연결", message: "서버에 연결하는 중" };
  }
  if (/Logged in with entity id|Joining world/i.test(value)) {
    return { kind: "info", stage: "월드 로딩", message: "월드를 불러오는 중" };
  }
  if (/Connection lost|Disconnected from server/i.test(value)) {
    return { kind: "info", stage: "연결 종료", message: "서버 연결이 끊겼습니다" };
  }
  return null;
}
