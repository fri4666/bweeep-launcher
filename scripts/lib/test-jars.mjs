import fsp from "node:fs/promises";
import { strToU8, zipSync } from "fflate";

/** Writes a real mod jar with just the metadata a loader reads, for launcher checks. */
export async function writeModJar(file, loader, modId, extra = {}) {
  const entries = { ...extra };
  if (loader === "fabric") entries["fabric.mod.json"] = strToU8(JSON.stringify({ schemaVersion: 1, id: modId, version: "1.0.0" }));
  if (loader === "forge") entries["META-INF/mods.toml"] = strToU8(`modLoader="javafml"\n[[mods]]\nmodId="${modId}"\nversion="1.0.0"\n`);
  if (loader === "neoforge") entries["META-INF/neoforge.mods.toml"] = strToU8(`modLoader="javafml"\n[[mods]]\nmodId="${modId}"\nversion="1.0.0"\n`);
  await fsp.writeFile(file, zipSync(entries));
}
