import { isModpackManifest, manifestForCatalog, resolveManifestDownloads } from "./manifest-shape.ts";

const manifest = {
  schemaVersion: 1, id: "bundle-test", name: "Bundle", version: "1", gameAuth: "yggdrasil" as const,
  minecraftVersion: "1.20.1", java: { majorVersion: 17, component: "java-runtime-gamma" },
  loader: { kind: "forge", version: "47.4.0" }, server: { host: "example.invalid", port: 25565 },
  files: [{ path: "mods/a.jar", size: 10, sha256: "0".repeat(64), url: "storage://bweeep-modpacks/a.jar" }]
};
const bundle = { url: "storage://bweeep-modpacks/install-bundles/test.zip", size: 100, sha512: "1".repeat(128), paths: ["mods/a.jar"] };
const insist = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

Deno.test("catalog omits only launch bundle pointers and preserves old metadata without mutation", () => {
  const old = manifestForCatalog(manifest);
  insist(JSON.stringify(old) === JSON.stringify(manifest), "Old catalog metadata changed");
  const input = { ...manifest, groupId: "friend-a" as const, audience: "testers" as const,
    initialInstallBundle: bundle, additionalMetadata: { preserved: true } };
  const before = JSON.stringify(input), output = manifestForCatalog(input);
  const { initialInstallBundle: _bundle, ...expected } = input;
  insist(!("initialInstallBundle" in output), "Private bundle pointer leaked into catalog");
  insist(JSON.stringify(output) === JSON.stringify(expected), "Other catalog fields changed");
  insist(output.groupId === "friend-a" && output.audience === "testers", "Group/audience metadata changed");
  insist(JSON.stringify(input) === before, "Stored catalog manifest was mutated");
});

Deno.test("optional private bundles require pinned bytes and canonical immutable paths", () => {
  insist(isModpackManifest({ ...manifest, initialInstallBundle: bundle }), "Valid private bundle refused");
  for (const invalid of [
    { ...bundle, url: "http://example.invalid/a.zip" }, { ...bundle, url: "storage://bweeep-modpacks/a/..%2Fb.zip" },
    { ...bundle, url: "storage://bweeep-modpacks/a.zip?ignored=true" }, { ...bundle, size: 0 }, { ...bundle, sha512: "bad" },
    { ...bundle, paths: [] }, { ...bundle, paths: Array(1) }, { ...bundle, paths: ["options.txt"] },
    { ...bundle, paths: ["mods/../a.jar"] }, { ...bundle, paths: ["mods/a.jar", "mods/A.jar"] }
  ]) insist(!isModpackManifest({ ...manifest, initialInstallBundle: invalid }), "Invalid private bundle accepted");
});

Deno.test("private file and partial bundle pointers sign for 15 minutes without mutating stored metadata", async () => {
  const calls: unknown[] = [];
  const storage = { from(bucket: string) { return { async createSignedUrl(object: string, expiresIn: number) {
    calls.push({ bucket, object, expiresIn }); return { data: { signedUrl: `https://signed.invalid/${calls.length}?token=fixture` }, error: null };
  } }; } };
  const input = { ...manifest, initialInstallBundle: bundle }, before = JSON.stringify(input);
  const resolved = await resolveManifestDownloads({ storage }, input);
  insist(resolved.files[0].url.startsWith("https://signed.invalid/"), "Private file was not signed");
  insist(resolved.initialInstallBundle?.url.startsWith("https://signed.invalid/"), "Private bundle was not signed");
  insist(resolved.initialInstallBundle?.size === bundle.size && resolved.initialInstallBundle.sha512 === bundle.sha512 &&
    JSON.stringify(resolved.initialInstallBundle.paths) === JSON.stringify(bundle.paths), "Pinned bundle metadata changed");
  insist(JSON.stringify(calls) === JSON.stringify([
    { bucket: "bweeep-modpacks", object: "a.jar", expiresIn: 900 },
    { bucket: "bweeep-modpacks", object: "install-bundles/test.zip", expiresIn: 900 }
  ]), "Unexpected signing authority or expiry");
  insist(JSON.stringify(input) === before, "Stored manifest was mutated");
});

Deno.test("HTTPS bundles pass through and old manifests gain no bundle field", async () => {
  const storage = { from() { throw new Error("Unexpected private signing"); } };
  const input = { ...manifest, files: [{ ...manifest.files[0], url: "https://cdn.invalid/a.jar" }] };
  const old = await resolveManifestDownloads({ storage }, input);
  insist(!("initialInstallBundle" in old), "Old manifest gained a bundle field");
  const source = { ...bundle, url: "https://cdn.invalid/bundle.zip" };
  const resolved = await resolveManifestDownloads({ storage }, { ...input, initialInstallBundle: source });
  insist(resolved.initialInstallBundle?.url === source.url, "HTTPS bundle changed");
});

Deno.test("private bundle signing failure refuses the manifest without exposing a download token", async () => {
  const storage = { from() { return { async createSignedUrl() { return { data: null, error: new Error("denied") }; } }; } };
  let refused = false;
  try { await resolveManifestDownloads({ storage }, { ...manifest, files: [], initialInstallBundle: bundle }); }
  catch (error) { refused = String(error).includes("initial install bundle") && !String(error).includes("token="); }
  insist(refused, "Failed private signing was not refused safely");
});

Deno.test("invalid partial bundle metadata fails before any storage signing", async () => {
  let called = false;
  const storage = { from() { called = true; throw new Error("Should not sign"); } };
  let refused = false;
  try { await resolveManifestDownloads({ storage }, { ...manifest, initialInstallBundle: { ...bundle, paths: ["saves/world.zip"] } }); }
  catch { refused = true; }
  insist(refused && !called, "Invalid bundle reached private storage");
});
