import type { ModpackManifest, ServerPreset } from "../shared/types.js";

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
    environment: manifest.audience === "testers" ? "test" : "production"
  };
}

function describeManifest(manifest: ModpackManifest): string {
  const client = manifest.loader.kind === "vanilla" ? "Vanilla" : `${manifest.loader.kind} ${manifest.loader.version}`;
  const server = manifest.serverLoader
    ? `${manifest.serverLoader.kind} ${manifest.serverLoader.version}`
    : client;
  return `Minecraft ${manifest.minecraftVersion} · 클라이언트 ${client} · 서버 ${server}`;
}
