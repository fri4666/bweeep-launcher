import fs from "node:fs/promises";
import { assertManifest } from "../dist/src/main/manifest-validation.js";
import { validateForPublish } from "./publish-manifest.mjs";

const read = async (name) => JSON.parse(await fs.readFile(new URL(`../resources/manifests/${name}.json`, import.meta.url), "utf8"));

// resources/manifests holds what production serves; publish-manifest.mjs is how it gets there.
const manifest = await read("vanilla-survival");
assertManifest(manifest);
validateForPublish(manifest);
if (manifest.server.port !== 25565 || !manifest.files.some((file) => file.path === "mods/fabric-api.jar")) {
  throw new Error("Vanilla manifest no longer matches the production 26.3 server.");
}

const testManifest = await read("vanilla-survival-test");
assertManifest(testManifest);
if (testManifest.audience !== "testers" || testManifest.server.port !== 25566) {
  throw new Error("Test manifest does not target the protected test server.");
}

const society = await read("society-sunlit-valley");
assertManifest(society);
validateForPublish(society);
if (society.loader.kind !== "forge" || society.serverLoader.kind !== "forge" || society.server.port !== 31234 ||
    society.files.length !== 24 || society.files.some((file) => file.path.startsWith("mods/bweeep-"))) {
  // Sign-in goes through authlib-injector now, so the pack ships no Bweeep server-auth bridge.
  throw new Error("Society manifest no longer matches the production Forge server on 31234.");
}

const refused = (label, candidate, check) => {
  try {
    check(candidate);
  } catch {
    return;
  }
  throw new Error(`${label} was accepted.`);
};
refused("Unsafe manifest file path", { ...manifest, files: [{ path: "../escape.jar", size: 1, sha256: "0".repeat(64), url: "https://example.test/escape.jar" }] }, assertManifest);
refused("An offline server", { ...manifest, gameAuth: "offline" }, validateForPublish);
refused("A manifest without gameAuth", { ...manifest, gameAuth: undefined }, validateForPublish);
refused("A file without a hash", { ...manifest, files: [{ ...manifest.files[0], sha256: undefined }] }, validateForPublish);
refused("A plain http download", { ...manifest, files: [{ ...manifest.files[0], url: "http://cdn.modrinth.com/x.jar" }] }, validateForPublish);
refused("A localhost server", { ...manifest, server: { host: "localhost", port: 25565 } }, validateForPublish);
refused("A port out of range", { ...manifest, server: { host: "server.fri4666.com", port: 70000 } }, validateForPublish);
console.log("Manifest validation passed.");
