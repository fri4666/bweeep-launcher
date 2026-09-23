import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";
import type { BundledClientMod } from "./companion-mod.js";

/**
 * Launcher-owned features are version and loader specific.  Keep this registry
 * separate from a modpack manifest so a remote manifest can never claim that a
 * missing bridge provides connection protection.
 */
export function bundledFeatureMods(resourcesRoot: string, manifest: ModpackManifest): BundledClientMod[] {
  if (!manifest.clientFeatures?.connectionLock) return [];

  if (manifest.loader.kind === "neoforge" && manifest.minecraftVersion === "1.21.1") {
    return [
      bundled(resourcesRoot, "bweeep-client-1.2.0.jar", "bweeep-client.jar", "4c8840d126f1939a1e66182cc086f3293bd0a8f75d5780d89df94ba23f02e70b"),
      bundled(resourcesRoot, "bweeep-display-name-0.2.0.jar", "bweeep-display-name.jar", "23f0c716cc8cb857ecf384f648a5c493745dd1bc9f53d1ab04ca9c40b632fed2")
    ];
  }

  if (manifest.loader.kind === "fabric" && manifest.minecraftVersion === "1.21.1") {
    return [
      bundled(resourcesRoot, "bweeep-fabric-0.2.0.jar", "bweeep-client.jar", "f9cf97cb7d615b61481c7c05580bcc1d2878eb3acc17a923ba0bad56b3c02736")
    ];
  }

  if (manifest.loader.kind === "fabric" && manifest.minecraftVersion === "26.3" && manifest.loader.version === "0.19.5") {
    return [
      bundled(resourcesRoot, "bweeep-fabric-lock-26.3-0.1.0.jar", "bweeep-client.jar", "5fe104672975a1f42d7640fd9508235c6e83c779585b4bd84037df9179354f5a")
    ];
  }

  throw new Error(`${manifest.minecraftVersion} ${manifest.loader.kind}용 붸에엡 연결 보호 모드가 아직 검증되지 않았습니다. 안전을 위해 이 서버의 연결 잠금 기능은 실행하지 않습니다.`);
}

function bundled(resourcesRoot: string, sourceName: string, targetName: string, sha256: string): BundledClientMod {
  return { sourcePath: path.join(resourcesRoot, sourceName), targetName, sha256 };
}
