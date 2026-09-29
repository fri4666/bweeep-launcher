import { isModpackManifest, parseStorageObjectUrl } from "./manifest-shape.ts";

const manifest = {
  schemaVersion: 1,
  id: "vanilla-survival",
  name: "Vanilla Survival",
  version: "2026.09.28",
  minecraftVersion: "26.3",
  java: { majorVersion: 25, component: "java-runtime-epsilon" },
  loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "server.fri4666.com", port: 25565 },
  files: [{ path: "mods/fabric-api.jar", size: 1, sha256: "0".repeat(64), url: "https://cdn.modrinth.com/x.jar" }]
};

Deno.test("stored manifests need hashed files and a Java runtime", () => {
  if (!isModpackManifest(manifest)) throw new Error("A valid manifest was refused.");
  if (isModpackManifest({ ...manifest, files: [{ ...manifest.files[0], sha256: undefined }] })) {
    throw new Error("A file without a hash was accepted.");
  }
  if (isModpackManifest({ ...manifest, java: { majorVersion: 7, component: "x" } })) throw new Error("Java 7 was accepted.");
});

Deno.test("storage URLs name a bucket and a path without ..", () => {
  const parsed = parseStorageObjectUrl("storage://bweeep-packs/society/4.1.5/lock.jar");
  if (parsed?.bucket !== "bweeep-packs" || parsed.path !== "society/4.1.5/lock.jar") throw new Error("Storage URL was misread.");
  if (parseStorageObjectUrl("https://cdn.modrinth.com/x.jar") !== null) throw new Error("An https URL was treated as storage.");
  let refused = false;
  try {
    // "..%2F" survives URL normalisation and only becomes "../" once decoded.
    parseStorageObjectUrl("storage://bweeep-packs/a/..%2Fb.jar");
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("A storage path with .. was accepted.");
});
