import fs from "node:fs/promises";
import { assertManifest } from "../dist/src/main/sync.js";

const manifest = JSON.parse(await fs.readFile(new URL("../resources/manifests/vanilla-survival.json", import.meta.url), "utf8"));
assertManifest(manifest);

const testManifest = JSON.parse(await fs.readFile(new URL("../resources/manifests/vanilla-survival-test.json", import.meta.url), "utf8"));
assertManifest(testManifest);
if (testManifest.audience !== "testers" || testManifest.server.port !== 25566) {
  throw new Error("Test manifest does not target the protected test server.");
}

let rejected = false;
try {
  assertManifest({ ...manifest, files: [{ path: "../escape.jar", size: 1, sha256: "0".repeat(64), url: "https://example.test/escape.jar" }] });
} catch {
  rejected = true;
}

if (!rejected) throw new Error("Unsafe manifest file path was accepted.");
console.log("Manifest validation passed.");
