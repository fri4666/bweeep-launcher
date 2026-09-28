import fsp from "node:fs/promises";
import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";
import { hashBytes, hashFile } from "./hash.js";

export interface BundledClientMod {
  sourcePath: string;
  targetName: string;
  sha256: string;
}

/**
 * Launcher-owned features are version and loader specific. Supported clients
 * are protected by default; a manifest can explicitly opt out, but cannot
 * claim that an unsupported client has a connection lock.
 */
export function bundledFeatureMods(resourcesRoot: string, manifest: ModpackManifest): BundledClientMod[] {
  if (manifest.clientFeatures?.connectionLock === false) return [];
  if (typeof manifest.clientFeatures?.connectionLock === "object") return [];

  if (manifest.loader.kind === "neoforge" && manifest.minecraftVersion === "1.21.1") {
    return [
      bundled(resourcesRoot, "bweeep-client-1.2.0.jar", "bweeep-client.jar", "71d39158b5899867a43759e86606e06e6a2483ac52eb799eeb10950a56f7257e"),
      bundled(resourcesRoot, "bweeep-display-name-0.2.0.jar", "bweeep-display-name.jar", "23f0c716cc8cb857ecf384f648a5c493745dd1bc9f53d1ab04ca9c40b632fed2")
    ];
  }

  if (manifest.loader.kind === "fabric" && manifest.minecraftVersion === "1.21.1") {
    return [
      bundled(resourcesRoot, "bweeep-fabric-0.2.0.jar", "bweeep-client.jar", "f9cf97cb7d615b61481c7c05580bcc1d2878eb3acc17a923ba0bad56b3c02736")
    ];
  }

  if (manifest.loader.kind === "fabric" && manifest.minecraftVersion === "1.21.4" && manifest.loader.version === "0.18.1") {
    return [
      bundled(resourcesRoot, "bweeep-connection-lock-1214-0.1.0.jar", "bweeep-client.jar", "60505e9e418f8c3c9ea60ac3124412b703e3642e22a083f3ef8a968156ee6c69")
    ];
  }

  if (manifest.loader.kind === "fabric" && manifest.minecraftVersion === "26.3" && manifest.loader.version === "0.19.5") {
    return [
      bundled(resourcesRoot, "bweeep-fabric-api-26.3.jar", "fabric-api.jar", "86f16178a3cecc887a85a4cfe9a79d92fa7341d8f39b5951a4d6ad800ab657a6"),
      bundled(resourcesRoot, "bweeep-fabric-lock-26.3-0.2.0.jar", "bweeep-client.jar", "27ed412e5bd1fb6d3b407776e9bd6c24c6297051a2862298289c51be1f98c472")
    ];
  }

  if (manifest.clientFeatures?.connectionLock === true) {
    throw new Error(`${manifest.minecraftVersion} ${manifest.loader.kind}용 붸에엡 연결 보호 모드가 아직 검증되지 않았습니다. 안전을 위해 이 서버의 연결 잠금 기능은 실행하지 않습니다.`);
  }
  return [];
}

function bundled(resourcesRoot: string, sourceName: string, targetName: string, sha256: string): BundledClientMod {
  return { sourcePath: path.join(resourcesRoot, sourceName), targetName, sha256 };
}

export async function ensureBundledClientMods(instanceDir: string, mods: BundledClientMod[]): Promise<void> {
  for (const mod of mods) {
    const contents = await fsp.readFile(mod.sourcePath);
    if (hashBytes("sha256", contents) !== mod.sha256) {
      throw new Error("붸에엡 전용 클라이언트 모드가 손상되었습니다.");
    }
    const target = path.join(instanceDir, "mods", mod.targetName);
    try {
      if (await hashFile(target, "sha256") === mod.sha256) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.part`;
    await fsp.writeFile(temp, contents);
    await fsp.rm(target, { force: true });
    await fsp.rename(temp, target);
  }
}

/** Verify the remote bridge again after player-owned mods have been copied. */
export async function verifyRemoteConnectionLock(instanceDir: string, manifest: ModpackManifest): Promise<void> {
  const lock = manifest.clientFeatures?.connectionLock;
  if (typeof lock !== "object") return;
  if (await hashFile(path.join(instanceDir, lock.path), "sha256") !== lock.sha256.toLowerCase()) {
    throw new Error("선택 서버 연결 보호 모드가 손상되었거나 개인 모드로 교체되었습니다.");
  }
}
