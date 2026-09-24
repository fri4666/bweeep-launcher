import fs from "node:fs/promises";
import { assertManifest } from "../dist/src/main/manifest-validation.js";

const manifest = JSON.parse(await fs.readFile(new URL("../resources/manifests/vanilla-survival.json", import.meta.url), "utf8"));
assertManifest(manifest);

const testManifest = JSON.parse(await fs.readFile(new URL("../resources/manifests/vanilla-survival-test.json", import.meta.url), "utf8"));
assertManifest(testManifest);
if (testManifest.audience !== "testers" || testManifest.server.port !== 25566) {
  throw new Error("Test manifest does not target the protected test server.");
}

const society = JSON.parse(await fs.readFile(new URL("../resources/manifests/society-sunlit-valley.json", import.meta.url), "utf8"));
assertManifest(society);
if (society.loader.kind !== "forge" || society.serverLoader.kind !== "forge" || society.files.length !== 26 ||
    society.files.filter((file) => file.path.startsWith("mods/bweeep-")).length !== 2) {
  throw new Error("Society manifest is missing its Forge server or required bridge files.");
}

let rejected = false;
try {
  assertManifest({ ...manifest, files: [{ path: "../escape.jar", size: 1, sha256: "0".repeat(64), url: "https://example.test/escape.jar" }] });
} catch {
  rejected = true;
}

if (!rejected) throw new Error("Unsafe manifest file path was accepted.");
console.log("Manifest validation passed.");
