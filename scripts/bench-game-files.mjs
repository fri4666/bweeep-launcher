// Real-network timing of the game-file preparation (Java, Minecraft files, loader) in
// an Electron main process, because the launcher's downloads go through Electron's
// network stack. A developer tool, not part of CI. It downloads several hundred MB.
//
//   npm run build && xvfb-run -a npx electron scripts/bench-game-files.mjs [--keep]
//
// Runs the preparation twice into a fresh folder: the first run is a first install,
// the second is what every later launch pays for files that are already there.
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

// Awaiting app.whenReady() at the top level never finishes in an ES module main; .then() does.
app.disableHardwareAcceleration();
app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function main() {
const { prepareGameFiles } = await import(path.join(root, "dist", "src", "main", "minecraft-runtime.js"));

await fsp.mkdir(path.join(homedir(), ".cache"), { recursive: true });
const dir = await fsp.mkdtemp(path.join(homedir(), ".cache", "bweeep-bench-game-"));
const manifest = {
  schemaVersion: 1, id: "bench-game", name: "Bench", version: "1", minecraftVersion: "1.21.1",
  java: { majorVersion: 21, component: "java-runtime-delta" }, loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "example.invalid", port: 25565 }, gameAuth: "yggdrasil", files: []
};

async function run(label) {
  const stages = [];
  const started = performance.now();
  await prepareGameFiles(manifest, dir, (event) => {
    if (typeof event.elapsedMs === "number" && event.message === "완료") {
      stages.push([event.stage, event.elapsedMs / 1000]);
      console.log(`   [${label}] ${event.stage} done in ${(event.elapsedMs / 1000).toFixed(1)} s`);
    }
    if (event.kind === "error") console.log(`   [${label}] ERROR ${event.stage}: ${event.message}`);
  });
  const total = (performance.now() - started) / 1000;
  console.log(`\n== ${label}: ${total.toFixed(1)} s`);
  for (const [stage, seconds] of stages) console.log(`   ${stage.padEnd(22)} ${seconds.toFixed(1).padStart(6)} s`);
  return total;
}

try {
  await run("first install (empty folder)");
  await run("second run (everything already there)");
  await run("third run");
  const size = async (folder) => {
    let bytes = 0;
    for (const entry of await fsp.readdir(folder, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) bytes += (await fsp.stat(path.join(entry.parentPath, entry.name))).size;
    }
    return bytes;
  };
  console.log(`\ninstalled size: ${((await size(dir)) / 1048576).toFixed(0)} MB`);
} finally {
  if (!keep) await fsp.rm(dir, { recursive: true, force: true });
  app.quit();
}
}
