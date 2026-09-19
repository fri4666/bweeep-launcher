import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { ModpackManifest, ServerPreset } from "../shared/types.js";
import { assertManifest } from "./sync.js";

/** Derive UI labels from the same manifest that controls installation. */
export async function getServerPresets(): Promise<ServerPreset[]> {
  const directory = path.join(app.getAppPath(), "resources", "manifests");
  const files = (await fsp.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const manifests = await Promise.all(files.map(async (file) => {
    const manifest = JSON.parse(await fsp.readFile(path.join(directory, file), "utf8")) as ModpackManifest;
    assertManifest(manifest);
    return manifest;
  }));
  return manifests.sort((left, right) => Number(Boolean(right.default)) - Number(Boolean(left.default))).map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    description: `Minecraft ${manifest.minecraftVersion} · ${manifest.loader.kind === "vanilla" ? "Vanilla" : `${manifest.loader.kind} ${manifest.loader.version}`}`,
    packId: manifest.id,
    server: manifest.server,
    minecraftVersion: manifest.minecraftVersion,
    java: manifest.java,
    loader: manifest.loader,
    serverLoader: manifest.serverLoader,
    environment: manifest.audience === "testers" ? "test" : "production"
  }));
}
