import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { freeDiskBytes } from "./download.js";
import { hashFile } from "./hash.js";

// Moves the launcher's own folders from one install location to another:
// the server instances and the personal content (mods, shaders, shared
// options). Anything else in the folders the player picked is never touched.

const USER_CONTENT = ".bweeep-user-content";
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

export interface InstallMovePlan {
  from: string;
  to: string;
  /** Names of the launcher's folders directly under `from`. */
  entries: string[];
  bytes: number;
  sameVolume: boolean;
  /** Why the files cannot be moved; the location can still be switched without them. */
  problem?: string;
}

export interface InstallMoveOptions {
  /** Tests: copy even on one volume, and fail on purpose before a step. */
  forceCopy?: boolean;
  fault?: (step: "rename" | "copy", name: string) => void;
  freeBytes?: (dir: string) => Promise<number | null>;
}

export interface InstallMoveResult {
  /** Removes the originals after the new location is saved. Nothing to do after a rename. */
  removeOriginals: () => Promise<void>;
}

export async function planInstallMove(fromInput: string, toInput: string, options: InstallMoveOptions = {}): Promise<InstallMovePlan> {
  const from = await realLocation(fromInput);
  const to = await realLocation(toInput);
  const entries = await launcherEntries(from);
  const plan: InstallMovePlan = { from, to, entries, bytes: 0, sameVolume: false };
  if (samePath(from, to)) return { ...plan, problem: "지금 위치와 같아요" };
  if (isInside(from, to) || isInside(to, from)) return { ...plan, problem: "지금 위치와 겹치는 폴더예요" };
  const target = await fsp.stat(to).catch(() => null);
  if (target && !target.isDirectory()) return { ...plan, problem: "폴더가 아니에요" };
  if (entries.length === 0) return plan;
  for (const name of entries) {
    if (await fsp.lstat(path.join(to, name)).catch(() => null)) return { ...plan, problem: "새 위치에 이미 붸에엡 파일이 있어요" };
  }
  const existing = await nearestExisting(to);
  const [fromStat, toStat] = await Promise.all([fsp.stat(from), fsp.stat(existing)]);
  plan.sameVolume = !options.forceCopy && fromStat.dev === toStat.dev;
  let links = false;
  for (const name of entries) {
    const size = await treeSize(path.join(from, name));
    plan.bytes += size.bytes;
    links ||= size.links;
  }
  if (!plan.sameVolume) {
    if (links) return { ...plan, problem: "바로가기 링크가 있어 옮길 수 없어요" };
    const free = await (options.freeBytes ?? freeDiskBytes)(existing);
    if (free !== null && free < plan.bytes + DISK_MARGIN_BYTES) {
      return { ...plan, problem: `새 위치에 공간이 부족해요 · ${toGb(plan.bytes + DISK_MARGIN_BYTES - free)}GB 더 필요해요` };
    }
  }
  return plan;
}

/**
 * All or nothing: on one volume every folder is renamed, and a failure
 * renames the moved ones back. Across volumes everything is copied and
 * checked by size and SHA-256 first; a failure removes only what was created
 * at the new location. The originals go only through `removeOriginals`.
 */
export async function moveInstall(plan: InstallMovePlan, onProgress: (percent: number) => void, options: InstallMoveOptions = {}): Promise<InstallMoveResult> {
  if (plan.problem) throw new Error(plan.problem);
  const createdDirs = await createDirs(plan.to);
  const nothing: InstallMoveResult = { removeOriginals: async () => removeEmptyDir(plan.from) };
  try {
    if (plan.sameVolume) {
      const renamed = await renameAll(plan, onProgress, options);
      if (renamed) return nothing;
    }
    await copyAll(plan, onProgress, options);
  } catch (error) {
    await removeCreatedDirs(createdDirs);
    throw error;
  }
  return {
    removeOriginals: async () => {
      for (const name of plan.entries) await removeEntry(plan.from, name);
      await removeEmptyDir(plan.from);
    }
  };
}

/** False when the volumes turn out to differ, so the caller copies instead. */
async function renameAll(plan: InstallMovePlan, onProgress: (percent: number) => void, options: InstallMoveOptions): Promise<boolean> {
  const moved: string[] = [];
  try {
    for (const name of plan.entries) {
      options.fault?.("rename", name);
      await fsp.rename(path.join(plan.from, name), path.join(plan.to, name));
      moved.push(name);
      onProgress(Math.floor((moved.length / plan.entries.length) * 100));
    }
    return true;
  } catch (error) {
    for (const name of moved.reverse()) await fsp.rename(path.join(plan.to, name), path.join(plan.from, name));
    if ((error as NodeJS.ErrnoException).code === "EXDEV" && moved.length === 0) return false;
    throw error;
  }
}

async function copyAll(plan: InstallMovePlan, onProgress: (percent: number) => void, options: InstallMoveOptions): Promise<void> {
  // Each byte is read twice: once while copying, once to check the copy.
  const total = Math.max(1, plan.bytes * 2);
  let done = 0;
  let reported = -1;
  const advance = (bytes: number) => {
    done += bytes;
    const percent = Math.min(99, Math.floor((done / total) * 100));
    if (percent !== reported) onProgress((reported = percent));
  };
  const created: string[] = [];
  try {
    for (const name of plan.entries) {
      created.push(name);
      await copyTree(path.join(plan.from, name), path.join(plan.to, name), name, advance, options);
    }
    onProgress(100);
  } catch (error) {
    for (const name of created) await removeEntry(plan.to, name);
    throw error;
  }
}

async function copyTree(source: string, target: string, relative: string, advance: (bytes: number) => void, options: InstallMoveOptions): Promise<void> {
  const stat = await fsp.lstat(source);
  if (stat.isDirectory()) {
    await fsp.mkdir(target);
    for (const entry of await fsp.readdir(source)) {
      await copyTree(path.join(source, entry), path.join(target, entry), `${relative}/${entry}`, advance, options);
    }
    return;
  }
  if (stat.isSymbolicLink()) throw new Error("바로가기 링크가 있어 옮길 수 없어요");
  if (!stat.isFile()) return;
  options.fault?.("copy", relative);
  const hash = createHash("sha256");
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      advance(chunk.length);
      callback(null, chunk);
    }
  });
  await pipeline(fs.createReadStream(source), counter, fs.createWriteStream(target, { flags: "wx" }));
  const copied = await fsp.stat(target);
  if (copied.size !== stat.size || await hashFile(target, "sha256") !== hash.digest("hex")) {
    throw new Error("옮긴 파일이 원본과 달라요");
  }
  advance(stat.size);
  // Same times as the original, so the launcher's hash cache still trusts the file.
  await fsp.utimes(target, stat.atime, stat.mtime);
}

/** Folders the launcher made: personal content, and instances it has installed into. */
async function launcherEntries(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === USER_CONTENT) names.push(entry.name);
    else if (INSTANCE_NAME.test(entry.name)) {
      const marks = await Promise.all(["bweeep-manifest.json", ".bweeep"].map((mark) => fsp.lstat(path.join(root, entry.name, mark)).catch(() => null)));
      if (marks.some(Boolean)) names.push(entry.name);
    }
  }
  return names.sort();
}

async function treeSize(target: string): Promise<{ bytes: number; links: boolean }> {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) return { bytes: 0, links: true };
  if (!stat.isDirectory()) return { bytes: stat.isFile() ? stat.size : 0, links: false };
  let bytes = 0;
  let links = false;
  for (const entry of await fsp.readdir(target)) {
    const child = await treeSize(path.join(target, entry));
    bytes += child.bytes;
    links ||= child.links;
  }
  return { bytes, links };
}

/**
 * Deletes one of the launcher's own folders directly under `root`. The name
 * is checked again here, so no path from elsewhere can reach the delete.
 */
async function removeEntry(root: string, name: string): Promise<void> {
  if (name !== USER_CONTENT && !INSTANCE_NAME.test(name)) throw new Error("지울 수 없는 폴더예요");
  const target = path.join(root, name);
  if (path.dirname(target) !== path.resolve(root)) throw new Error("지울 수 없는 폴더예요");
  await fsp.rm(target, { recursive: true, force: true });
}

async function removeEmptyDir(dir: string): Promise<void> {
  await fsp.rmdir(dir).catch(() => undefined);
}

/** Directories made for the new location, deepest last, so a failure can take back only those. */
async function createDirs(dir: string): Promise<string[]> {
  const first = await fsp.mkdir(dir, { recursive: true });
  if (!first) return [];
  const created: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    created.unshift(current);
    if (samePath(current, first) || path.dirname(current) === current) break;
  }
  return created;
}

async function removeCreatedDirs(created: string[]): Promise<void> {
  for (const dir of [...created].reverse()) await removeEmptyDir(dir);
}

/** The real path of the deepest part that exists, so links cannot hide an overlap. */
async function realLocation(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || !path.isAbsolute(input)) throw new Error("설치 위치가 올바르지 않습니다.");
  const resolved = path.resolve(input);
  const existing = await nearestExisting(resolved);
  const real = await fsp.realpath(existing).catch(() => existing);
  return path.join(real, path.relative(existing, resolved));
}

async function nearestExisting(dir: string): Promise<string> {
  let current = path.resolve(dir);
  while (!(await fsp.stat(current).catch(() => null))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

function toGb(bytes: number): string {
  return Math.max(0.1, bytes / 1073741824).toFixed(1);
}
