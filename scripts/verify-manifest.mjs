import fs from "node:fs/promises";
import { assertManifest } from "../dist/src/main/sync.js";

const manifest = JSON.parse(await fs.readFile(new URL("../resources/manifests/create-aeronautics.json", import.meta.url), "utf8"));
assertManifest(manifest);

let rejected = false;
try {
  assertManifest({ ...manifest, files: [{ ...manifest.files[0], path: "../escape.jar" }] });
} catch {
  rejected = true;
}

if (!rejected) throw new Error("Unsafe manifest file path was accepted.");
console.log("Manifest validation passed.");
