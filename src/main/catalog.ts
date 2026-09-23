import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { ModpackManifest, ServerPreset } from "../shared/types.js";
import { assertManifest } from "./sync.js";
import type { LauncherChannel } from "./launcher-channel.js";

/** Derive UI labels from the same manifest that controls installation. */
export async function getServerPresets(channel: LauncherChannel = "production"): Promise<ServerPreset[]> {
  const directory = await findManifestDirectory();
  const files = (await fsp.readdir(directory))
    .filter((name) => name === "vanilla-survival.json" || name === "vanilla-survival-test.json")
    .sort();
  const manifests = await Promise.all(files.map(async (file) => {
    const manifest = JSON.parse(await fsp.readFile(path.join(directory, file), "utf8")) as ModpackManifest;
    assertManifest(manifest);
    return manifest;
  }));
  return manifests.sort((left, right) => {
    if (channel === "test") return Number(right.audience === "testers") - Number(left.audience === "testers");
    return Number(Boolean(right.default)) - Number(Boolean(left.default));
  }).map(toServerPreset);
}

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

async function findManifestDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(app.getAppPath(), "resources", "manifests"),
    path.resolve(moduleDirectory, "../../../resources", "manifests")
  ];
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Try the next location. Startup tests load the main module through a bootstrap script.
    }
  }
  throw new Error("사용 가능한 서버 manifest 디렉터리를 찾지 못했습니다.");
}
