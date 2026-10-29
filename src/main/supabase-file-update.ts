import { fetchUpdateArtifact } from "./update-delivery.js";
import { app, net } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { LauncherUpdate, LauncherUpdateStatus } from "../shared/types.js";
import { releaseFileUrl, safeUpdatePath, updatePartCount, UPDATE_CHUNK_SIZE, UPDATE_STORAGE_ROOT, verifyFileUpdateManifest, type FileUpdateEntry, type FileUpdateManifest } from "./file-update-manifest.js";
import { isProtectedInstallRoot, launchProtectedInstaller, prepareProtectedInstaller, type PreparedInstaller } from "./protected-installer.js";
import { startFileUpdateHelper } from "./file-update-broker.js";

const CHECK_INTERVAL_MS = 60_000;
const arch = process.arch === "arm64" ? "arm64" : "x64";
let publish: (status: LauncherUpdateStatus) => void = () => undefined;
let canInstall: (playerAsked: boolean) => boolean = () => true;
let status: LauncherUpdateStatus = { state: "checking" };
let audience = false;
let currentManifest: FileUpdateManifest | null = null;
let staged: string | null = null;
let changed: FileUpdateEntry[] = [];
let checkInFlight = false;
let installScheduled = false;
let activeDownload: AbortController | null = null;
let protectedInstaller: PreparedInstaller | null = null;
let declinedVersion: string | null = null;

export function fileUpdatesAvailable(): boolean {
  return process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64") &&
    fs.existsSync(path.join(process.resourcesPath, "bweeep-update-public-key.pem"));
}

export function startFileUpdates(
  publishStatus: (status: LauncherUpdateStatus) => void,
  mayInstall: (playerAsked: boolean) => boolean,
  initialTester: boolean
): void {
  publish = publishStatus;
  canInstall = mayInstall;
  audience = initialTester;
  void checkFileUpdates();
  const timer = setInterval(() => void checkFileUpdates(), CHECK_INTERVAL_MS);
  timer.unref();
}

export function setFileUpdateAudience(tester: boolean): void {
  if (audience === tester) return;
  audience = tester;
  activeDownload?.abort();
  currentManifest = null;
  staged = null;
  changed = [];
  protectedInstaller = null;
  installScheduled = false;
  setStatus({ state: "checking" });
  void checkFileUpdates();
}

export function installFileUpdate(options: { playerAsked?: boolean } = {}): void {
  const playerAsked = options.playerAsked === true;
  if (status.state !== "ready" || !currentManifest || !staged || installScheduled || !canInstall(playerAsked)) return;
  if (!playerAsked && declinedVersion === currentManifest.version) return;
  const manifest = currentManifest;
  const stage = staged;
  const files = changed;
  installScheduled = true;
  setStatus({ state: "installing", update: status.update });
  setTimeout(() => {
    if (!canInstall(playerAsked) || currentManifest !== manifest) {
      installScheduled = false;
      setStatus(currentManifest === manifest ? { state: "ready", update: status.update } : { state: "current" });
      return;
    }
    void handOffUpdate(manifest, stage, files).catch((error) => {
      installScheduled = false;
      setStatus({ state: "error", update: status.update, message: safeError(error) });
    });
  }, 5_000);
}

async function checkFileUpdates(): Promise<void> {
  if (checkInFlight || ["downloading", "ready", "installing"].includes(status.state)) return;
  checkInFlight = true;
  const requestedAudience = audience;
  const channel = requestedAudience ? "beta" : "stable";
  try {
    const key = await fsp.readFile(path.join(process.resourcesPath, "bweeep-update-public-key.pem"), "utf8");
    const response = await net.fetch(`${UPDATE_STORAGE_ROOT}/channels/${channel}/${arch}.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`업데이트 목록을 받지 못했습니다. (${response.status})`);
    const manifest = verifyFileUpdateManifest(await response.json(), key, app.getVersion(), channel, arch);
    if (audience !== requestedAudience) return;
    if (!manifest) {
      setStatus({ state: "current" });
      return;
    }
    const update: LauncherUpdate = { version: manifest.version, notes: [] };
    setStatus({ state: "available", update });
    currentManifest = manifest;
    const controller = new AbortController();
    activeDownload = controller;
    await prepareFiles(manifest, controller.signal, update, key);
    if (audience !== requestedAudience || currentManifest !== manifest) return;
    setStatus({ state: "ready", update });
    installFileUpdate();
  } catch (error) {
    if (audience !== requestedAudience || (error instanceof Error && error.name === "AbortError")) return;
    setStatus({ state: "error", update: status.update, message: safeError(error) });
  } finally {
    activeDownload = null;
    checkInFlight = false;
    if (audience !== requestedAudience) void checkFileUpdates();
  }
}

async function prepareFiles(manifest: FileUpdateManifest, signal: AbortSignal, update: LauncherUpdate, publicKey: string): Promise<void> {
  const root = path.dirname(app.getPath("exe"));
  const stage = path.join(app.getPath("userData"), "launcher-update-stage", `${manifest.version}-${manifest.arch}`);
  await fsp.mkdir(stage, { recursive: true });
  protectedInstaller = null;
  if (isProtectedInstallRoot(root)) {
    protectedInstaller = await prepareProtectedInstaller({
      version: manifest.version, arch: manifest.arch, publicKey, stage, signal,
      fetcher: net.fetch,
      progress: (received, total) => setStatus({ state: "downloading", update, percent: Math.round(received / total * 100) })
    });
    staged = stage;
    changed = [];
    return;
  }
  const needed: FileUpdateEntry[] = [];
  for (const file of manifest.files) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const installed = path.join(root, ...file.path.split("/"));
    if (await matchesFile(installed, file)) continue;
    needed.push(file);
  }
  changed = needed;
  staged = stage;
  const total = needed.reduce((sum, file) => sum + file.packedSize, 0);
  let received = 0;
  for (const file of needed) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const destination = path.join(stage, ...file.path.split("/"));
    if (await matchesFile(destination, file)) {
      received += file.packedSize;
      continue;
    }
    setStatus({ state: "downloading", update, percent: total ? Math.round(received / total * 100) : 100 });
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part`;
    const packedTemporary = `${destination}.gz.part`;
    try {
      for (let part = 0; part < updatePartCount(file.packedSize); part++) {
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
        const response = await fetchUpdateArtifact(releaseFileUrl(manifest, file.path, part), { signal: downloadSignal }, net.fetch);
        if (!response.ok || !response.body) throw new Error(`업데이트 파일을 받지 못했습니다. (${response.status})`);
        await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(packedTemporary, { flags: part === 0 ? "w" : "a" }), { signal: downloadSignal });
        const partSize = Math.min(UPDATE_CHUNK_SIZE, file.packedSize - part * UPDATE_CHUNK_SIZE);
        received += partSize;
        setStatus({ state: "downloading", update, percent: total ? Math.round(received / total * 100) : 100 });
      }
      if (!await matchesFile(packedTemporary, { ...file, size: file.packedSize, sha256: file.packedSha256 })) {
        throw new Error(`압축된 업데이트 파일 검증에 실패했습니다: ${file.path}`);
      }
      await pipeline(fs.createReadStream(packedTemporary), createGunzip(), fs.createWriteStream(temporary), { signal });
      if (!await matchesFile(temporary, file)) throw new Error(`업데이트 파일 검증에 실패했습니다: ${file.path}`);
      await fsp.rename(temporary, destination);
    } finally {
      await fsp.rm(temporary, { force: true });
      await fsp.rm(packedTemporary, { force: true });
    }
  }
}

async function matchesFile(filePath: string, expected: FileUpdateEntry): Promise<boolean> {
  try {
    const metadata = await fsp.stat(filePath);
    if (!metadata.isFile() || metadata.size !== expected.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function handOffUpdate(manifest: FileUpdateManifest, stage: string, files: FileUpdateEntry[]): Promise<void> {
  const root = path.dirname(app.getPath("exe"));
  if (isProtectedInstallRoot(root)) {
    const installer = protectedInstaller;
    if (!installer || installer.version !== manifest.version || installer.arch !== manifest.arch) throw new Error("검증된 설치 파일이 없습니다.");
    const result = await launchProtectedInstaller(installer, root);
    if (result === "cancelled") {
      declinedVersion = manifest.version;
      installScheduled = false;
      setStatus({ state: "ready", update: status.update });
      return;
    }
    app.quit();
    return;
  }
  const currentList = path.join(process.resourcesPath, "bweeep-update-files.json");
  let removed: string[] = [];
  try {
    const local = JSON.parse(await fsp.readFile(currentList, "utf8")) as { schema?: number; files?: string[] };
    if (local.schema !== 1 || !Array.isArray(local.files)) throw new Error("invalid local file list");
    const next = new Set(manifest.files.map((file) => file.path.toLowerCase()));
    removed = local.files.map(safeUpdatePath).filter((file) => !next.has(file.toLowerCase()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const helperSource = path.join(process.resourcesPath, "file-update-helper.ps1");
  const helper = path.join(stage, "file-update-helper.ps1");
  await fsp.copyFile(helperSource, helper);
  const id = randomUUID();
  const planPath = path.join(stage, `plan-${id}.json`);
  const plan = { id, root, staged: stage, parentPid: process.pid, changed: files, removed };
  await fsp.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  await startFileUpdateHelper(helper, planPath);
  app.quit();
}

function setStatus(next: LauncherUpdateStatus): void {
  status = next;
  publish(next);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "업데이트 서버").slice(0, 180) || "자동 업데이트에 실패했습니다.";
}
