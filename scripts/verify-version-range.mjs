import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { mavenRangeAccepts, semverRangeAccepts } from "../dist/src/main/version-range.js";
import { fitsMinecraft, parseModMetadata } from "../dist/src/main/mod-metadata.js";
import { prepareUserContent } from "../dist/src/main/user-content.js";

// [range, version, expected]; null means "cannot tell", which never blocks a mod.
const semverCases = [
  ["*", "1.20.1", true],
  ["", "26.3", true],
  ["1.20.1", "1.20.1", true],
  ["1.20.1", "1.20.2", false],
  ["=1.20.1", "1.20.1", true],
  ["1.20", "1.20.0", true],
  [">=1.20 <1.21", "1.20.1", true],
  [">=1.20 <1.21", "1.21", false],
  [">=1.20 <1.21", "1.19.4", false],
  [">=1.20- <1.21-", "1.20", true],
  [">=1.20- <1.21-", "1.21", false],
  [">=1.21-alpha.24.10.a", "1.21.4", true],
  [">1.20.1", "1.20.1", false],
  ["<=1.20.1", "1.20.1", true],
  [">= 1.20", "1.20.4", true],
  ["~1.20", "1.20.6", true],
  ["~1.20", "1.21", false],
  ["~1.20.1", "1.20.4", true],
  ["~1.20.1", "1.20.0", false],
  ["~1", "1.99", true],
  ["^1.20", "1.21.4", true],
  ["^1.20", "26.3", false],
  ["^26.1", "26.3", true],
  ["1.20.x", "1.20.1", true],
  ["1.20.x", "1.21", false],
  ["1.20.X", "1.20", true],
  ["1.20.*", "1.20.4", true],
  ["1.x", "1.21.4", true],
  ["1.x", "26.3", false],
  [">=1.20.x", "1.21", true],
  ["26.3", "26.3", true],
  ["26.3", "26.3.1", false],
  ["26.x", "26.3", true],
  [">=26.1", "26.3", true],
  [">=26.1", "1.21.4", false],
  ["~26.3", "26.3.2", true],
  ["~26.3", "26.4", false],
  [">=1.21.4", "26.3", true],
  ["1.20.1 || 1.20.2", "1.20.2", true],
  ["1.20.1 || 1.20.2", "1.20.3", false],
  ["1.20.1 || weird", "1.20.3", null],
  ["23w13a", "1.20.1", null],
  [">=${minecraft_version}", "1.20.1", null],
  [">=1.20", "24w14a", null]
];
for (const [range, version, expected] of semverCases) {
  assert.equal(semverRangeAccepts(range, version), expected, `semver ${JSON.stringify(range)} vs ${version}`);
}

const mavenCases = [
  ["[1.20,1.21)", "1.20.1", true],
  ["[1.20,1.21)", "1.21", false],
  ["[1.20,1.21)", "1.19.2", false],
  ["[1.20.1]", "1.20.1", true],
  ["[1.20.1]", "1.20.2", false],
  ["[1.20.1,)", "26.3", true],
  ["(1.20.1,)", "1.20.1", false],
  ["(,1.21)", "1.20.6", true],
  ["(,1.21]", "1.21", true],
  ["[1.19.2],[1.20.1]", "1.20.1", true],
  ["[1.19.2],[1.20.1]", "1.20.2", false],
  ["[1.18,1.19),[1.20,1.21)", "1.20.4", true],
  ["[ 1.20.1 , 1.20.2 ]", "1.20.2", true],
  ["[26.1,27)", "26.3", true],
  ["[26.1,27)", "1.21.1", false],
  ["1.20.1", "1.21", true],
  ["*", "1.20.1", true],
  ["${minecraft_version_range}", "1.20.1", null],
  ["[1.20", "1.20.1", null],
  ["[1.20,1.21", "1.20.1", null],
  ["", "1.20.1", null]
];
for (const [range, version, expected] of mavenCases) {
  assert.equal(mavenRangeAccepts(range, version), expected, `maven ${JSON.stringify(range)} vs ${version}`);
}
console.log(`version-range-cases=passed (${semverCases.length + mavenCases.length})`);

const entries = (files) => new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(typeof text === "string" ? text : JSON.stringify(text))]));
const fabric = (depends) => ({ "fabric.mod.json": { schemaVersion: 1, id: "sample", depends } });
const forgeToml = (range, extra = "") => `modLoader="javafml"
loaderVersion="[47,)"
[[mods]]
modId="sample"
version="1.0.0"
[[dependencies.sample]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
[[dependencies.sample]]
    modId="minecraft"
    mandatory=true
    versionRange="${range}" # comment
    ordering="NONE"
    side="BOTH"
${extra}`;

const metadataCases = [
  [fabric({ minecraft: "~1.20" }), "fabric", "1.20.1", true],
  [fabric({ minecraft: "~1.20" }), "fabric", "26.3", false],
  [fabric({ minecraft: ["1.20.1", "1.20.2"] }), "fabric", "1.20.2", true],
  [fabric({ minecraft: ["1.20.1", "1.20.2"] }), "fabric", "1.21", false],
  [fabric({ minecraft: ">=1.21.4" }), "fabric", "26.3", true],
  [fabric({ fabricloader: ">=0.15" }), "fabric", "26.3", true],
  [fabric({ minecraft: 42 }), "fabric", "26.3", true],
  [fabric({ minecraft: "1.20.x" }), "fabric", "not-a-version", true],
  [{ "quilt.mod.json": { quilt_loader: { id: "sample", depends: [{ id: "minecraft", versions: ">=1.20 <1.21" }] } } }, "fabric", "1.21", true],
  [{ "META-INF/mods.toml": forgeToml("[1.20,1.21)") }, "forge", "1.20.1", true],
  [{ "META-INF/mods.toml": forgeToml("[1.20,1.21)") }, "forge", "1.21.1", false],
  [{ "META-INF/mods.toml": forgeToml("[1.20.1]") }, "forge", "1.20.2", false],
  [{ "META-INF/mods.toml": forgeToml("${minecraft_version_range}") }, "forge", "1.20.1", true],
  [{ "META-INF/mods.toml": forgeToml("[1.20,1.21)", "[[dependencies.other]]\n    modId=\"minecraft\"\n    versionRange=\"[1.20.1]\"\n") }, "forge", "1.20.4", false],
  [{ "META-INF/mods.toml": forgeToml("[1.20,1.21)").replace('mandatory=true\n    versionRange="[1.20,1.21)"', 'type="incompatible"\n    versionRange="[1.20,1.21)"') }, "forge", "1.21.1", true],
  [{ "META-INF/neoforge.mods.toml": forgeToml("[1.21.1,1.22)").replaceAll("mandatory=true", 'type="required"') }, "neoforge", "1.21.1", true],
  [{ "META-INF/neoforge.mods.toml": forgeToml("[1.21.1,1.22)").replaceAll("mandatory=true", 'type="required"') }, "neoforge", "1.20.1", false],
  // A Forge-era jar on NeoForge is read from mods.toml.
  [{ "META-INF/mods.toml": forgeToml("[1.20.1,1.20.2)") }, "neoforge", "1.20.1", true],
  // A multi-loader jar is judged by the metadata the pack's loader reads.
  [{ ...fabric({ minecraft: "1.20.1" }), "META-INF/mods.toml": forgeToml("[1.21,)") }, "fabric", "1.20.1", true],
  [{ ...fabric({ minecraft: "1.20.1" }), "META-INF/mods.toml": forgeToml("[1.21,)") }, "forge", "1.20.1", false]
];
for (const [files, loader, version, expected] of metadataCases) {
  assert.equal(fitsMinecraft(parseModMetadata(entries(files)), loader, version), expected, `${Object.keys(files).join("+")} on ${loader} ${version}`);
}
console.log(`mod-metadata-minecraft-ranges=passed (${metadataCases.length})`);

// At launch, a personal jar for another Minecraft version is left out with a short reason.
const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-version-range-"));
try {
  const jar = (file, files) => fsp.writeFile(file, zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) =>
    [name, strToU8(typeof value === "string" ? value : JSON.stringify(value))]))));
  const personal = path.join(root, ".bweeep-user-content", "mods", "fabric-26.3");
  const instance = path.join(root, "pack");
  await Promise.all([fsp.mkdir(personal, { recursive: true }), fsp.mkdir(path.join(instance, "mods"), { recursive: true })]);
  await Promise.all([
    jar(path.join(personal, "old-minimap.jar"), { "fabric.mod.json": { schemaVersion: 1, id: "old_minimap", depends: { minecraft: "~1.21.4" } } }),
    jar(path.join(personal, "new-minimap.jar"), { "fabric.mod.json": { schemaVersion: 1, id: "new_minimap", depends: { minecraft: ">=26.3" } } }),
    jar(path.join(personal, "any-zoom.jar"), { "fabric.mod.json": { schemaVersion: 1, id: "any_zoom", depends: { minecraft: "*" } } }),
    jar(path.join(personal, "odd-range.jar"), { "fabric.mod.json": { schemaVersion: 1, id: "odd_range", depends: { minecraft: "26w14a" } } })
  ]);
  const status = await prepareUserContent(root, instance, { id: "pack", loader: { kind: "fabric" }, minecraftVersion: "26.3", files: [] });
  assert.deepEqual(status.skippedMods, [{ name: "old-minimap.jar", reason: "26.3 버전용 모드가 아니에요" }]);
  assert.deepEqual((await fsp.readdir(path.join(instance, "mods"))).sort(), ["any-zoom.jar", "new-minimap.jar", "odd-range.jar"]);
  console.log("personal-mod-minecraft-version-check=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
