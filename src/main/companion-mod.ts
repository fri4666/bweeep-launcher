import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export interface BundledClientMod {
  sourcePath: string;
  targetName: string;
  sha256: string;
}

export async function ensureBundledClientMods(instanceDir: string, mods: BundledClientMod[]): Promise<void> {
  for (const mod of mods) await ensureBundledClientMod(instanceDir, mod);
}

async function ensureBundledClientMod(instanceDir: string, mod: BundledClientMod): Promise<void> {
  const contents = await fsp.readFile(mod.sourcePath);
  const sourceHash = crypto.createHash("sha256").update(contents).digest("hex");
  if (sourceHash !== mod.sha256) {
    throw new Error("붸에엡 전용 클라이언트 모드가 손상되었습니다.");
  }

  const target = path.join(instanceDir, "mods", mod.targetName);
  try {
    const current = await fsp.readFile(target);
    if (crypto.createHash("sha256").update(current).digest("hex") === mod.sha256) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.part`;
  await fsp.writeFile(temp, contents);
  await fsp.rm(target, { force: true });
  await fsp.rename(temp, target);
}
