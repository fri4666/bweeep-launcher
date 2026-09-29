import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { listPersonalMods, refetchPreviousMods, removeMod, setModrinthNetwork } from "../dist/src/main/modrinth.js";
import { hashFile } from "../dist/src/main/hash.js";

// Personal Modrinth mods after the server moves to a new Minecraft version,
// against a fake Modrinth: nothing here reaches the real API.

const HASH = "a".repeat(128);
const projects = {
  AAAAAAAA: "Minimap",
  BBBBBBBB: "Zoom",
  CCCCCCCC: "Old Thing",
  DDDDDDDD: "Library",
  PPPPPPPP: "Pack Mod"
};
let failingDownload = "BBBBBBBB";
const version = (projectId, minecraft, dependencies = []) => ({
  id: `${projectId.slice(0, 4)}${minecraft.replace(/\./g, "")}`.padEnd(8, "0").slice(0, 8),
  project_id: projectId,
  version_number: `${projects[projectId].replace(/\s/g, "")}-${minecraft}`,
  version_type: "release",
  game_versions: [minecraft],
  loaders: ["fabric"],
  files: [{ url: `https://cdn.modrinth.com/data/${projectId}/${minecraft}.jar`, filename: `${projectId.toLowerCase()}-${minecraft}.jar`, primary: true, size: 10, hashes: { sha512: HASH } }],
  dependencies
});
const versions = [
  version("AAAAAAAA", "1.21.4", [{ project_id: "DDDDDDDD", dependency_type: "required" }]),
  version("AAAAAAAA", "26.3", [{ project_id: "DDDDDDDD", dependency_type: "required" }]),
  version("BBBBBBBB", "1.21.4"),
  version("BBBBBBBB", "26.3"),
  version("CCCCCCCC", "1.21.4"),
  version("DDDDDDDD", "1.21.4"),
  version("DDDDDDDD", "26.3"),
  version("PPPPPPPP", "1.21.4"),
  version("PPPPPPPP", "26.3")
];
const requests = [];
let packJarHash = "";

setModrinthNetwork({
  async fetch(url, init) {
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/^\/v2/, "");
    requests.push(`${init?.method ?? "GET"} ${route}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let match;
    if ((match = /^\/project\/([A-Za-z0-9]+)\/version$/.exec(route))) {
      const loaders = JSON.parse(parsed.searchParams.get("loaders"));
      const gameVersions = JSON.parse(parsed.searchParams.get("game_versions"));
      return json(versions.filter((item) => item.project_id === match[1] && item.loaders.some((loader) => loaders.includes(loader)) && item.game_versions.some((game) => gameVersions.includes(game))));
    }
    if ((match = /^\/project\/([A-Za-z0-9]+)$/.exec(route))) {
      return projects[match[1]] ? json({ id: match[1], title: projects[match[1]], server_side: "optional", client_side: "required", project_type: "mod" }) : json({}, 404);
    }
    if ((match = /^\/version\/([A-Za-z0-9]+)$/.exec(route))) {
      const found = versions.find((item) => item.id === match[1]);
      return found ? json(found) : json({}, 404);
    }
    if (route === "/version_files") {
      const { hashes } = JSON.parse(init.body);
      return json(Object.fromEntries(hashes.filter((hash) => hash === packJarHash).map((hash) => [hash, { project_id: "PPPPPPPP" }])));
    }
    return json({}, 404);
  },
  async download(files) {
    for (const file of files) {
      if (file.urls[0].includes(`/${failingDownload}/`)) throw new Error("download failed");
      await fsp.writeFile(file.path, `jar from ${file.urls[0]}`);
    }
  }
});

async function setup(root) {
  const oldDir = path.join(root, ".bweeep-user-content", "mods", "fabric-1.21.4");
  const instance = path.join(root, "pack");
  await Promise.all([fsp.mkdir(oldDir, { recursive: true }), fsp.mkdir(path.join(instance, "mods"), { recursive: true })]);
  const old = [
    ["AAAAAAAA", true], ["DDDDDDDD", false], ["BBBBBBBB", true], ["CCCCCCCC", true], ["PPPPPPPP", true]
  ].map(([projectId, explicit]) => {
    const item = versions.find((entry) => entry.project_id === projectId && entry.game_versions[0] === "1.21.4");
    return { projectId, versionId: item.id, versionNumber: item.version_number, title: projects[projectId], fileName: item.files[0].filename, explicit };
  });
  await Promise.all(old.map((mod) => fsp.writeFile(path.join(oldDir, mod.fileName), "old jar")));
  await fsp.writeFile(path.join(oldDir, ".bweeep-modrinth.json"), JSON.stringify(old));
  // The server pack now ships Pack Mod itself.
  await fsp.writeFile(path.join(instance, "mods", "pack-mod.jar"), "pack jar");
  packJarHash = await hashFile(path.join(instance, "mods", "pack-mod.jar"), "sha512");
  // Nothing recorded yet: the installed pack still says what the server was.
  await fsp.writeFile(path.join(instance, "bweeep-manifest.json"), JSON.stringify({ id: "pack", minecraftVersion: "1.21.4", loader: { kind: "fabric", version: "0.18.1" } }));
  return { oldDir, newDir: path.join(root, ".bweeep-user-content", "mods", "fabric-26.3") };
}

const jarsIn = async (dir) => (await fsp.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".jar")).sort();
const target = (root) => ({ instanceRoot: root, packId: "pack", loader: "fabric", minecraftVersion: "26.3", blockedModrinthProjects: [] });

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-mod-refetch-"));
try {
  const { oldDir, newDir } = await setup(root);
  const listed = await listPersonalMods(target(root), true);
  assert.deepEqual(listed.map((mod) => [mod.projectId, mod.previousTarget, mod.unavailable ?? null]), [
    ["AAAAAAAA", "Fabric 1.21.4", null],
    ["BBBBBBBB", "Fabric 1.21.4", null],
    ["CCCCCCCC", "Fabric 1.21.4", "맞는 버전 없음"],
    ["PPPPPPPP", "Fabric 1.21.4", null]
  ], "explicit previous-version mods are listed; dependencies are not");
  assert.ok(requests.every((request) => !request.startsWith("POST") || request.endsWith("/version_files")));

  // One failed download keeps everything as it was.
  await assert.rejects(() => refetchPreviousMods(target(root), []), /download failed/);
  assert.deepEqual(await jarsIn(newDir), [], "a failed refetch leaves no new files");
  assert.equal((await jarsIn(oldDir)).length, 5, "a failed refetch keeps every old file");
  assert.equal((await listPersonalMods(target(root), false)).filter((mod) => mod.previousTarget).length, 4);

  failingDownload = "none";
  const refetched = await refetchPreviousMods(target(root), []);
  assert.deepEqual(await jarsIn(newDir), ["aaaaaaaa-26.3.jar", "bbbbbbbb-26.3.jar", "dddddddd-26.3.jar"]);
  assert.deepEqual(refetched.map((mod) => [mod.projectId, mod.explicit, mod.previousTarget ?? null, mod.unavailable ?? null]), [
    ["AAAAAAAA", true, null, null],
    ["DDDDDDDD", false, null, null],
    ["BBBBBBBB", true, null, null],
    ["CCCCCCCC", true, "Fabric 1.21.4", "맞는 버전 없음"]
  ]);
  // No other server uses Fabric 1.21.4, so the replaced files go; the library stays for Old Thing.
  assert.deepEqual(await jarsIn(oldDir), ["cccccccc-1.21.4.jar", "dddddddd-1.21.4.jar"]);

  await removeMod(target(root), "CCCCCCCC");
  assert.deepEqual(await jarsIn(oldDir), ["dddddddd-1.21.4.jar"]);
  const settled = await listPersonalMods(target(root), false);
  assert.ok(settled.every((mod) => !mod.previousTarget));
  const remembered = JSON.parse(await fsp.readFile(path.join(root, ".bweeep-user-content", "mods", "pack-targets.json"), "utf8"));
  assert.deepEqual(remembered.pack, { loader: "fabric", minecraftVersion: "26.3" }, "once nothing is left behind the new pair is remembered");
  console.log("modrinth-refetch-for-new-version=passed");

  // Another server still on Fabric 1.21.4 keeps its files.
  const sharedRoot = path.join(root, "shared");
  const shared = await setup(sharedRoot);
  await refetchPreviousMods(target(sharedRoot), [{ loader: "fabric", minecraftVersion: "1.21.4" }]);
  assert.equal((await jarsIn(shared.oldDir)).length, 5, "old files stay while another server uses them");
  assert.equal((await jarsIn(shared.newDir)).length, 3);
  console.log("modrinth-refetch-keeps-shared-old-files=passed");

  // A server that moved to another loader lists its old mods the same way.
  const loaderRoot = path.join(root, "loader");
  await setup(loaderRoot);
  const neoforge = await listPersonalMods({ ...target(loaderRoot), loader: "neoforge", minecraftVersion: "1.21.4" }, false);
  assert.ok(neoforge.length === 4 && neoforge.every((mod) => mod.previousTarget === "Fabric 1.21.4"));
  console.log("modrinth-previous-loader-mods-listed=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
