import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {hostApi} from "./api.mjs";

const snapshotName = /^snap-[0-9]{13}$/;
const games = ["cobblebox-weekday-fabric-1.7.42", "cobbleverse-fabric-1.7.42"];

async function complete(root, id) {
  if (!snapshotName.test(id)) throw new Error("Invalid snapshot ID");
  const directory = path.join(root, id);
  if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== directory) {
    throw new Error("Snapshot is not a direct directory");
  }
  const meta = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8"));
  if (meta.id !== id || !["pc", "vps"].includes(meta.source) || !Number.isSafeInteger(meta.epoch)) {
    throw new Error("Invalid snapshot metadata");
  }
  for (const game of games) {
    if (!(await fs.stat(path.join(directory, "servers", game, "world", "level.dat"))).isFile()) {
      throw new Error("Snapshot world is incomplete");
    }
  }
  return meta;
}

async function latestId(root) {
  const pointer = path.join(root, "latest");
  if (!(await fs.lstat(pointer)).isSymbolicLink()) throw new Error("Latest must be a symbolic link");
  const target = await fs.realpath(pointer);
  const id = path.basename(target);
  if (path.dirname(target) !== root || !snapshotName.test(id)) throw new Error("Latest escaped snapshot storage");
  await complete(root, id);
  return id;
}

// Delete only older managed backups after the coordinator acknowledges a complete replacement.
// Newer/incoming copies and any pointer changed during cleanup remain protected.
export async function pruneSnapshots(directory, record, {dryRun = false} = {}) {
  const root = await fs.realpath(directory);
  const keep = record?.snapshotId;
  if (!snapshotName.test(keep ?? "")) throw new Error("No acknowledged snapshot");
  const meta = await complete(root, keep);
  if (meta.epoch !== record.snapshotEpoch || meta.source !== record.snapshotSource) {
    throw new Error("Acknowledged snapshot metadata differs");
  }
  const latest = await latestId(root);
  const entries = await fs.readdir(root, {withFileTypes: true});
  const candidates = entries.filter(entry => entry.isDirectory() && snapshotName.test(entry.name) &&
    entry.name < keep && entry.name !== latest).map(entry => entry.name).sort();
  let removed = 0;
  for (const id of candidates) {
    if (id === await latestId(root)) continue;
    const target = path.join(root, id);
    // Recheck the exact path before every recursive operation.
    if (!(await fs.lstat(target)).isDirectory() || await fs.realpath(target) !== target ||
        path.dirname(target) !== root) throw new Error("Cleanup target changed");
    if (!dryRun) await fs.rm(target, {recursive: true});
    removed++;
  }
  return {acknowledged: keep, latest, olderSnapshots: removed, dryRun};
}

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  if (!["pc", "vps"].includes(config.node) ||
      config.standbyRoot !== "/var/lib/bweeep-host-agent/standby") throw new Error("Invalid cleanup configuration");
  const state = await hostApi(config)("launcher_host_state", {p_cluster: config.cluster});
  const record = state.nodes.find(node => node.node === config.node);
  const result = await pruneSnapshots(config.standbyRoot, record, {dryRun: process.argv.includes("--dry-run")});
  console.log("SNAPSHOT_PRUNE_SUCCESS", JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("SNAPSHOT_PRUNE_FAILED", error.message); process.exitCode = 1; });
}
