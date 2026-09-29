import type { ModpackManifest, ServerPreset } from "../shared/types.js";
import { assertManifest } from "./manifest-validation.js";

/** Maps the remote manifest that controls installation to the matching UI card. */
export function toServerPreset(manifest: ModpackManifest): ServerPreset {
  return {
    id: manifest.id,
    name: manifest.name,
    description: describeManifest(manifest),
    packId: manifest.id,
    default: manifest.default === true,
    server: manifest.server,
    minecraftVersion: manifest.minecraftVersion,
    java: manifest.java,
    loader: manifest.loader,
    serverLoader: manifest.serverLoader,
    environment: manifest.audience === "testers" ? "test" : "production",
    gameAuth: manifest.gameAuth ?? "offline",
    blockedModrinthProjects: manifest.blockedModrinthProjects ?? []
  };
}

/**
 * Server cards for every manifest that passes validation. One broken manifest
 * is reported through `onSkip` and left out instead of hiding every server;
 * only a catalog with nothing usable is an error.
 */
export function presetsFromManifests(
  manifests: ModpackManifest[],
  onSkip: (manifest: unknown, reason: string) => void
): ServerPreset[] {
  const presets: ServerPreset[] = [];
  for (const manifest of manifests) {
    try {
      assertManifest(manifest);
      presets.push(toServerPreset(manifest));
    } catch (error) {
      onSkip(manifest, error instanceof Error ? error.message : String(error));
    }
  }
  if (manifests.length > 0 && presets.length === 0) throw new Error("서버 정보를 읽지 못했어요.");
  return presets;
}

/** Offline-mode servers are not supported: players sign in with their Bweeep account everywhere. */
export function requireBweeepAccounts(manifest: ModpackManifest): void {
  if (manifest.gameAuth !== "yggdrasil") throw new Error("지원하지 않는 접속 방식의 서버예요.");
}

function describeManifest(manifest: ModpackManifest): string {
  const client = manifest.loader.kind === "vanilla" ? "Vanilla" : `${manifest.loader.kind} ${manifest.loader.version}`;
  const server = manifest.serverLoader
    ? `${manifest.serverLoader.kind} ${manifest.serverLoader.version}`
    : client;
  return `Minecraft ${manifest.minecraftVersion} · 클라이언트 ${client} · 서버 ${server}`;
}
