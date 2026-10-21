import path from "node:path";
import fsp from "node:fs/promises";
import { LaunchPrecheck, MinecraftFolder, Version, createMinecraftProcessWatcher, launch, type ResolvedVersion } from "@xmcl/core";
import {
  createDefaultNodeInstallRuntime,
  createFabricInstallWorkflow,
  createJavaRuntimeInstallWorkflow,
  createModernForgeInstallWorkflow,
  executeInstallManifest,
  executeInstallWorkflow,
  getPotentialJavaLocations,
  getFabricLoaderArtifact,
  getVersionList,
  resolveAssetMetadataInstallFiles,
  resolveAssetObjectInstallFiles,
  resolveJava,
  resolveJavaWithDiagnostic,
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  resolveMinecraftVersionJsonInstallFile,
  resolveNeoForgedInstallerFile
} from "@xmcl/installer";
import { MIN_GAME_MEMORY_MB, type GameMemory } from "../shared/game-memory.js";
import type { ModpackManifest, SyncProgress } from "../shared/types.js";
import { ensureBundledClientMods, removeStaleLockMod, verifyRemoteConnectionLock, type BundledClientMod } from "./client-feature-mods.js";
import type { LaunchIdentity } from "./launch-identity.js";
import { describeGameExit, type GameExitResult } from "./game-exit.js";
import { createGameOutputObserver } from "./game-telemetry.js";
import { InstalledVersions } from "./installed-versions.js";
import { HashCache } from "./hash-cache.js";
import { downloadInstallFilesWithSystemNetwork, fetchWithSystemNetwork } from "./system-network.js";
import { isUsableSystemJava } from "./system-java.js";

type ProgressSink = (event: SyncProgress) => void;
type InstallRuntime = ReturnType<typeof createDefaultNodeInstallRuntime>;

export interface LaunchAuthorization {
  identity: LaunchIdentity;
  /** One-time ticket for servers running bweeep-server-auth; empty otherwise. */
  ticket: string;
  /** Set for servers that verify players through the Bweeep Yggdrasil API. */
  yggdrasil?: { jvmArgs: string[] };
}

/** What the game needs before the pack's own files matter: Java, the Minecraft files and the loader. */
export interface PreparedGame {
  javaPath: string;
  version: string;
  /** Shared with the final, post-sync checks so unchanged libraries are not read twice. */
  runtimeHashes?: HashCache;
}

function createInstallContext(progress: ProgressSink, instanceDir: string, hashes: HashCache): { report: ProgressSink; runtime: InstallRuntime } {
  let activeStage = "게임 파일";
  const report: ProgressSink = (event) => {
    if (event.stage) activeStage = event.stage;
    progress(event);
  };
  const runtime = createDefaultNodeInstallRuntime({
    download: (files) => {
      const batchStage = activeStage;
      let lastReport = Number.NEGATIVE_INFINITY;
      return downloadInstallFilesWithSystemNetwork(files, (completed, total, filePath, phase) => {
        // Thousands of small assets otherwise send several IPC/log writes per
        // file. Keep actual first/final counters and at most four updates/sec.
        const now = Date.now();
        if (completed < total && now - lastReport < 250) return;
        lastReport = now;
        progress({
          kind: phase === "done" ? "info" : "download",
          stage: batchStage,
          // `completed` has a fractional part while big files are still coming in.
          message: `받는 중 ${Math.floor(completed)}/${total}`,
          completed,
          total,
          unit: "files",
          filePath
        });
      });
    }
  });
  const checksum = runtime.checksum;
  runtime.checksum = (target, algorithm) => algorithm === "sha1" || algorithm === "sha256" || algorithm === "sha512"
    ? hashes.checksum(path.relative(instanceDir, target), target, algorithm).then((hash) => hash ?? "")
    : checksum(target, algorithm);
  return { report, runtime };
}

/**
 * Java, the Minecraft files and the loader. None of it depends on the modpack
 * files, so a launch can run this while the pack is still syncing. It touches
 * nothing in `mods/` and not the loader's launch libraries: a pack can bring
 * some of those itself, and they are checked once the sync is over.
 */
export async function prepareGameFiles(manifest: ModpackManifest, instanceDir: string, progress: ProgressSink): Promise<PreparedGame> {
  if (!["vanilla", "neoforge", "forge", "fabric"].includes(manifest.loader.kind)) {
    throw new Error("지원하지 않는 Minecraft 로더입니다.");
  }
  const runtimeHashes = await HashCache.load(path.join(instanceDir, ".bweeep", "runtime-hashes.json"));
  const { report, runtime } = createInstallContext(progress, instanceDir, runtimeHashes);
  const javaContext = createInstallContext(progress, instanceDir, runtimeHashes);
  const loaderContext = createInstallContext(progress, instanceDir, runtimeHashes);
  const assetContext = createInstallContext(progress, instanceDir, runtimeHashes);
  const minecraft = MinecraftFolder.from(instanceDir);
  // Versions installed by an earlier launch need no metadata from Mojang, Fabric or Forge.
  const installed = InstalledVersions.forInstance(instanceDir);
  const isUsable = (versionId: string) => Version.parse(minecraft, versionId).then(() => true);
  const loaderKey = `${manifest.loader.kind}:${manifest.minecraftVersion}:${manifest.loader.version}`;
  try {
    // These write separate folders. Keep their progress contexts separate and
    // drain both lanes on failure before the caller starts another launch.
    const [java, base] = await Promise.allSettled([
      runStage(javaContext.report, "Java 런타임", () => resolveRuntime(instanceDir, manifest.java, javaContext.runtime, javaContext.report)),
      runStage(report, "Minecraft 기본 파일", () => installMinecraftBase(minecraft, manifest.minecraftVersion, runtime, report, installed))
    ]);
    if (java.status === "rejected") throw java.reason;
    if (base.status === "rejected") throw base.reason;
    const javaPath = java.value;
    // Loaders need the base JAR/libraries and Java, not the asset objects.
    // The base version record is settled before a loader can remember its ID.
    const [loader, assets] = await Promise.allSettled([
      manifest.loader.kind === "vanilla" ? Promise.resolve(base.value.id)
        : manifest.loader.kind === "fabric"
          ? runStage(loaderContext.report, "Fabric 설치", async () => (await installed.reuseOrInstall(loaderKey, isUsable, () => installFabric(minecraft, manifest, loaderContext.runtime, loaderContext.report))).versionId)
          : runStage(loaderContext.report, manifest.loader.kind === "forge" ? "Forge 설치" : "NeoForge 설치", async () =>
            (await installed.reuseOrInstall(loaderKey, isUsable, () => installForgeFamily(minecraft, manifest, javaPath, loaderContext.runtime, loaderContext.report))).versionId),
      runStage(assetContext.report, "게임 리소스", () => installMinecraftAssets(minecraft, base.value, assetContext.runtime, assetContext.report))
    ]);
    if (loader.status === "rejected") throw loader.reason;
    if (assets.status === "rejected") throw assets.reason;
    return { javaPath, version: loader.value, runtimeHashes };
  } finally {
    // The digest cache is optional. A full disk or read-only cache must not
    // hide a real preparation error or make an otherwise usable game fail.
    await runtimeHashes.save().catch(() => undefined);
  }
}

export async function installAndLaunch(
  manifest: ModpackManifest,
  instanceDir: string,
  getLaunchAuthorization: () => Promise<LaunchAuthorization>,
  bundledClientMods: BundledClientMod[],
  progress: ProgressSink,
  onExit: (exit: GameExitResult) => void,
  /** JVM arguments of the connection guard agent; empty when the pack opts out. */
  connectionGuardArgs: string[] = [],
  memory: Pick<GameMemory, "minMb" | "maxMb"> = { minMb: MIN_GAME_MEMORY_MB, maxMb: 6144 },
  /** The game files, when the caller already started preparing them next to the pack sync. */
  preparing?: Promise<PreparedGame>
): Promise<{ pid: number; version: string }> {
  const prepared = await (preparing ?? prepareGameFiles(manifest, instanceDir, progress));
  const { javaPath, version } = prepared;
  const runtimeHashes = prepared.runtimeHashes ?? await HashCache.load(path.join(instanceDir, ".bweeep", "runtime-hashes.json"));
  const { report, runtime } = createInstallContext(progress, instanceDir, runtimeHashes);
  const minecraft = MinecraftFolder.from(instanceDir);
  // After the pack sync: files the pack brings itself (the Fabric libraries, for one) are already in place and skipped.
  const resolvedVersion = await runStage(report, "실행 라이브러리", () => installLaunchLibraries(minecraft, version, runtime, report));
  if (await removeStaleLockMod(instanceDir, manifest, bundledClientMods)) {
    report({ kind: "info", stage: "게임 파일", message: "안 쓰는 예전 모드 정리" });
  }
  if (manifest.loader.kind !== "vanilla") {
    await ensureBundledClientMods(instanceDir, bundledClientMods);
  }
  const remoteLock = manifest.clientFeatures?.connectionLock;
  if (typeof remoteLock === "object") {
    await verifyRemoteConnectionLock(instanceDir, manifest);
    report({ kind: "info", stage: "서버 연결 보호", message: "확인됨" });
  }
  // The guard agent sets bweeep.targetServer itself; older lock mods read the same property.
  const legacyLockOnly = connectionGuardArgs.length === 0 && (remoteLock === true
    || typeof remoteLock === "object"
    || bundledClientMods.some((mod) => mod.targetName === "bweeep-client.jar"));
  const quickPlayPath = path.join(instanceDir, "quickPlay", "bweeep.json");
  await fsp.mkdir(path.dirname(quickPlayPath), { recursive: true });

  const { identity, ticket: gameTicket, yggdrasil } = await runStage(report, "접속 인증", getLaunchAuthorization);
  report({ kind: "info", stage: "게임 실행", message: "준비 중" });
  const gameProcess = await launch({
    gamePath: instanceDir,
    resourcePath: instanceDir,
    javaPath,
    version: resolvedVersion,
    prechecks: cachedLaunchPrechecks(instanceDir, runtimeHashes),
    accessToken: identity.accessToken,
    gameProfile: { id: identity.id, name: identity.name },
    // authlib-injector expects "mojang"; offline servers keep the legacy type.
    userType: yggdrasil ? "mojang" : "legacy",
    quickPlayMultiplayer: `${manifest.server.host}:${manifest.server.port}`,
    extraJVMArgs: [
      ...(yggdrasil?.jvmArgs ?? []),
      ...connectionGuardArgs,
      ...(legacyLockOnly ? [`-Dbweeep.targetServer=${manifest.server.host}:${manifest.server.port}`] : [])
    ],
    extraMCArgs: ["--quickPlayPath", quickPlayPath],
    extraExecOption: {
      env: { ...process.env, BWEEP_GAME_TICKET: gameTicket }
    },
    minMemory: memory.minMb,
    maxMemory: memory.maxMb
  // Never reject a successful spawn over an optional cache write: the caller
  // must receive the PID and the exit observers below must always be attached.
  }).finally(() => runtimeHashes.save().catch(() => undefined));
  report({ kind: "info", stage: "게임 프로세스", message: "창 여는 중" });
  gameProcess.stdout?.on("data", createGameOutputObserver(report));
  gameProcess.stderr?.on("data", createGameOutputObserver(report));
  const watcher = createMinecraftProcessWatcher(gameProcess);
  watcher.once("minecraft-window-ready", () => {
    report({ kind: "info", stage: "게임 초기화", message: "화면 준비 중" });
  });
  // The caller reports the exit: only it knows whether the player asked to stop.
  watcher.once("minecraft-exit", ({ code, signal, crashReport, crashReportLocation }) => {
    onExit(describeGameExit({ code, signal, crashReport, crashReportLocation }));
  });
  watcher.once("error", (error) => {
    const message = `게임을 켜지 못했어요: ${error instanceof Error ? error.message : String(error)}`;
    report({ kind: "error", stage: "게임 실행", message });
    onExit({ abnormal: true, message, code: null, signal: null, crashReportLocation: null });
  });
  return { pid: gameProcess.pid ?? 0, version };
}

async function installFabric(
  minecraft: MinecraftFolder,
  manifest: ModpackManifest,
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", stage: "Fabric", message: `Fabric ${manifest.loader.version}` });
  const loader = await getFabricLoaderArtifact(manifest.minecraftVersion, manifest.loader.version, { fetch: fetchWithSystemNetwork });
  const installed = await executeInstallWorkflow(createFabricInstallWorkflow({
    minecraftVersion: manifest.minecraftVersion,
    version: loader.loader.version,
    minecraft,
    side: "client",
    fetch: fetchWithSystemNetwork
  }), runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "Fabric", event)
  });
  return installed;
}

async function installLaunchLibraries(
  minecraft: MinecraftFolder,
  versionId: string,
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<ResolvedVersion> {
  const resolved = await Version.parse(minecraft, versionId);
  const files = resolveLibraryInstallFiles(resolved.libraries, minecraft)
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (files.length === 0) return resolved;
  progress({ kind: "info", stage: "실행 라이브러리", message: `${files.length}개 확인` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-launch-libraries", type: "files", files }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "실행 라이브러리", event)
  });
  return resolved;
}

/** The same core checks, sharing digests already verified by the installer. */
export function cachedLaunchPrechecks(instanceDir: string, hashes: HashCache): LaunchPrecheck[] {
  const matches = async (target: string, expected: string | undefined): Promise<boolean> => {
    if (!expected) return fsp.access(target).then(() => true, () => false);
    return await hashes.checksum(path.relative(instanceDir, target), target, "sha1").catch(() => null) === expected;
  };
  return [
    async (resource, version) => {
      const expected = version.downloads.client?.sha1;
      if (expected && !await matches(resource.getVersionJar(version.minecraftVersion), expected)) {
        throw Object.assign(new Error(`Corrupted Version jar ${resource.getVersionJar(version.minecraftVersion)}. Either the file not reachable or the file sha1 not matched!`), {
          error: "CorruptedVersionJar", version: version.minecraftVersion
        });
      }
    },
    async (resource, version) => {
      const valid = await Promise.all(version.libraries.map((library) => matches(resource.getLibraryByPath(library.download.path), library.download.sha1)));
      const corrupted = version.libraries.filter((_, index) => !valid[index]);
      if (corrupted.length > 0) {
        throw Object.assign(new Error(`Missing ${corrupted.length} libraries! Either the file not reachable or the file sha1 not matched!`), {
          error: "MissingLibraries", libraries: corrupted, version
        });
      }
    },
    LaunchPrecheck.checkNatives,
    LaunchPrecheck.linkAssets
  ];
}

async function runStage<T>(progress: ProgressSink, stage: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  progress({ kind: "info", stage, message: "준비 중" });
  try {
    const result = await action();
    progress({ kind: "info", stage, elapsedMs: Date.now() - startedAt, message: "완료" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress({ kind: "error", stage, elapsedMs: Date.now() - startedAt, message: `${stage} 실패: ${message}` });
    throw error;
  }
}

async function resolveRuntime(
  instanceDir: string,
  requiredJava: ModpackManifest["java"],
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<string> {
  const bundled = process.platform === "win32"
    ? path.join(instanceDir, ".bweeep", "runtime", "bin", "javaw.exe")
    : path.join(instanceDir, ".bweeep", "runtime", "bin", "java");
  // The Mojang runtime for the pack's Java component comes first; a Java that
  // happens to be on the PC may be 32-bit or a build the game does not like.
  const installed = await resolveJava(bundled);
  if (installed && installed.majorVersion === requiredJava.majorVersion) return installed.path;
  try {
    return await installMojangRuntime(bundled, requiredJava, runtime, progress);
  } catch (error) {
    for (const candidate of await getPotentialJavaLocations()) {
      const probe = await resolveJavaWithDiagnostic(candidate);
      if (isUsableSystemJava(probe, requiredJava.majorVersion)) {
        progress({ kind: "info", stage: "Java 런타임", message: `PC의 Java ${requiredJava.majorVersion} 사용` });
        return probe.java!.path;
      }
    }
    throw error;
  }
}

async function installMojangRuntime(
  bundled: string,
  requiredJava: ModpackManifest["java"],
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", stage: "Java 런타임", message: `Java ${requiredJava.majorVersion} 받는 중` });
  const platform = process.platform === "win32"
    ? process.arch === "arm64" ? "windows-arm64" : "windows-x64"
    : process.platform === "darwin" ? process.arch === "arm64" ? "mac-os-arm64" : "mac-os"
    : "linux";
  const response = await fetchWithSystemNetwork("https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json");
  if (!response.ok) throw new Error("Java 런타임 목록을 가져오지 못했습니다.");
  const catalog = await response.json() as Record<string, Record<string, Array<unknown>>>;
  const targets = catalog[platform]?.[requiredJava.component];
  if (!targets?.[0]) throw new Error(`이 PC용 Java ${requiredJava.majorVersion} 런타임을 찾지 못했습니다.`);
  await executeInstallWorkflow(
    createJavaRuntimeInstallWorkflow({ target: targets[0] as Parameters<typeof createJavaRuntimeInstallWorkflow>[0]["target"], destination: path.dirname(path.dirname(bundled)) }),
    runtime,
    { onEvent: (event) => publishInstallerEvent(progress, "Java 런타임", event) }
  );
  const java = await resolveJava(bundled);
  if (!java || java.majorVersion !== requiredJava.majorVersion) {
    throw new Error(`Java ${requiredJava.majorVersion} 설치를 확인하지 못했습니다.`);
  }
  return java.path;
}

async function installMinecraftBase(
  minecraft: MinecraftFolder,
  minecraftVersion: string,
  runtime: InstallRuntime,
  progress: ProgressSink,
  installed: InstalledVersions
): Promise<ResolvedVersion> {
  progress({ kind: "info", stage: "게임 정보", message: `Minecraft ${minecraftVersion}` });
  const { versionId } = await installed.reuseOrInstall(`minecraft:${minecraftVersion}`, (id) => Version.parse(minecraft, id).then(() => true), async () => {
    const entry = (await getVersionList({ fetch: fetchWithSystemNetwork })).versions.find((item) => item.id === minecraftVersion);
    if (!entry) throw new Error(`Minecraft ${minecraftVersion} 정보를 찾지 못했습니다.`);
    await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-version", type: "files", files: [resolveMinecraftVersionJsonInstallFile(entry, minecraft)] }] }, runtime);
    return minecraftVersion;
  });
  const resolved = await Version.parse(minecraft, versionId);
  const baseFiles = [
    resolveMinecraftJarInstallFile(resolved),
    ...resolveLibraryInstallFiles(resolved.libraries, minecraft),
    ...resolveAssetMetadataInstallFiles(resolved, minecraft)
  ].filter((file): file is NonNullable<typeof file> => Boolean(file));
  progress({ kind: "info", stage: "라이브러리", message: `${baseFiles.length}개 준비` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-base", type: "files", files: baseFiles }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "라이브러리", event)
  });
  return resolved;
}

async function installMinecraftAssets(
  minecraft: MinecraftFolder,
  resolved: ResolvedVersion,
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<void> {
  const assetFiles = await resolveAssetObjectInstallFiles(resolved, minecraft);
  progress({ kind: "info", stage: "게임 리소스", message: `${assetFiles.length}개 준비` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-assets", type: "files", files: assetFiles }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "게임 리소스", event)
  });
}

async function installForgeFamily(
  minecraft: MinecraftFolder,
  manifest: ModpackManifest,
  javaPath: string,
  runtime: InstallRuntime,
  progress: ProgressSink
): Promise<string> {
  const project = manifest.loader.kind === "forge" ? "forge" : "neoforge";
  const stage = project === "forge" ? "Forge" : "NeoForge";
  progress({ kind: "info", stage, message: `${stage} ${manifest.loader.version}` });
  const forgeVersion = `${manifest.minecraftVersion}-${manifest.loader.version}`;
  const installer = project === "forge"
    ? await resolveForgeInstallerFile(minecraft, forgeVersion)
    : (await resolveNeoForgedInstallerFile(project, manifest.loader.version, minecraft, {})).file;
  const installed = await executeInstallWorkflow(
    createModernForgeInstallWorkflow({
      id: `${project}-${project === "forge" ? forgeVersion : manifest.loader.version}`,
      minecraft,
      minecraftVersion: manifest.minecraftVersion,
      installer,
      artifactVersion: project === "forge" ? forgeVersion : manifest.loader.version,
      java: javaPath,
      installOptions: {},
      side: "client"
    }),
    runtime,
    { onEvent: (event) => publishInstallerEvent(progress, stage, event) }
  );
  return installed.version;
}

async function resolveForgeInstallerFile(minecraft: MinecraftFolder, version: string) {
  const relative = `net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
  const url = `https://maven.minecraftforge.net/${relative}`;
  const response = await fetchWithSystemNetwork(`${url}.sha1`);
  if (!response.ok) throw new Error("Forge 설치 파일의 해시를 가져오지 못했습니다.");
  const sha1 = (await response.text()).trim();
  if (!/^[a-f0-9]{40}$/i.test(sha1)) throw new Error("Forge 설치 파일의 해시가 올바르지 않습니다.");
  return {
    path: minecraft.getLibraryByPath(relative),
    urls: [url],
    checksum: { algorithm: "sha1" as const, value: sha1 }
  };
}

// Stage start/finish and download counts already come from runStage and the
// download callback, so only installer events that tell the player something
// new are forwarded. Task ids go to the launch log, not the UI text.
function publishInstallerEvent(progress: ProgressSink, stage: string, event: unknown): void {
  const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
  const message = installEventMessage(record);
  if (!message) return;
  const task = record.task && typeof record.task === "object" ? record.task as Record<string, unknown> : {};
  progress({ kind: "info", stage, message, filePath: typeof task.id === "string" ? task.id : undefined });
}

function installEventMessage(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "task-end": return event.error ? "설치 실패" : null;
    case "file-retry": return `다시 받는 중${typeof event.attempt === "number" ? ` ${event.attempt}` : ""}`;
    case "java-strategy-start": return "Java 설치 확인";
    case "java-strategy-failed": return "다른 방법으로 Java 설치";
    default: return null;
  }
}
