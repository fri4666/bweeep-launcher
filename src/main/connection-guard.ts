import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";
import { ensureVerifiedCopy } from "./verified-copy.js";

/**
 * bweeep-guard keeps the game on the selected server. It is a Java agent
 * that patches Netty's Bootstrap, which every Minecraft client since 1.7
 * connects through, so one jar covers every version and loader, vanilla
 * included. Source: java-agent/.
 */
const GUARD = {
  fileName: "bweeep-guard-1.1.0.jar",
  sha256: "57a2d566a946b86738d884c783795455ca52d5f9021c351adfe65341c30b55af"
};

/** On unless a manifest explicitly opts out. */
export function connectionGuardEnabled(manifest: ModpackManifest): boolean {
  return manifest.clientFeatures?.connectionLock !== false;
}

export function ensureConnectionGuard(resourcesRoot: string, instanceDir: string): Promise<string> {
  return ensureVerifiedCopy(
    path.join(resourcesRoot, GUARD.fileName),
    GUARD.sha256,
    path.join(instanceDir, ".bweeep", "bweeep-guard.jar"),
    "서버 연결 보호 파일이 손상되었습니다. 런처를 다시 설치해 주세요."
  );
}

/** The game also ends when its connection to the server closes, so no menu is left to play from. */
export function connectionGuardJvmArgs(agentPath: string, manifest: ModpackManifest): string[] {
  return [`-javaagent:${agentPath}`, `-Dbweeep.targetServer=${manifest.server.host}:${manifest.server.port}`, "-Dbweeep.exitOnLeave=true"];
}
