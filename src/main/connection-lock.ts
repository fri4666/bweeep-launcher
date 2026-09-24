import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";

/** Verify the remote bridge again after player-owned mods have been copied. */
export async function verifyRemoteConnectionLock(instanceDir: string, manifest: ModpackManifest): Promise<void> {
  const lock = manifest.clientFeatures?.connectionLock;
  if (typeof lock !== "object") return;
  const bytes = await fsp.readFile(path.join(instanceDir, lock.path));
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== lock.sha256.toLowerCase()) {
    throw new Error("선택 서버 연결 보호 모드가 손상되었거나 개인 모드로 교체되었습니다.");
  }
}
