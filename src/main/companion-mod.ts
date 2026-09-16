import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const COMPANION_MOD_SHA256 = "6a0dcf577c5d43e7a5afd8f312277b7baea3c22263ea6476e3e45a95420ebc2f";

export async function ensureCompanionMod(instanceDir: string, sourcePath: string): Promise<void> {
  const contents = await fsp.readFile(sourcePath);
  const sourceHash = crypto.createHash("sha256").update(contents).digest("hex");
  if (sourceHash !== COMPANION_MOD_SHA256) {
    throw new Error("붸에엡 전용 클라이언트 모드가 손상되었습니다.");
  }

  const target = path.join(instanceDir, "mods", "bweeep-client.jar");
  try {
    const current = await fsp.readFile(target);
    if (crypto.createHash("sha256").update(current).digest("hex") === COMPANION_MOD_SHA256) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.part`;
  await fsp.writeFile(temp, contents);
  await fsp.rm(target, { force: true });
  await fsp.rename(temp, target);
}
