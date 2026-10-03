import path from "node:path";
import fsp from "node:fs/promises";
import { MinecraftFolder, Version, createMinecraftProcessWatcher, launch } from "@xmcl/core";
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

export async function installAndLaunch(
  manifest: ModpackManifest,
  instanceDir: string,
  getLaunchAuthorization: () => Promise<LaunchAuthorization>,
  bundledClientMods: BundledClientMod[],
  progress: ProgressSink,
  onExit: (exit: GameExitResult) => void,
  /** JVM arguments of the connection guard agent; empty when the pack opts out. */
  connectionGuardArgs: string[] = [],
  memory: Pick<GameMemory, "minMb" | "maxMb"> = { minMb: MIN_GAME_MEMORY_MB, maxMb: 6144 }
): Promise<{ pid: number; version: string }> {
  if (!["vanilla", "neoforge", "forge", "fabric"].includes(manifest.loader.kind)) {
    throw new Error("지원하지 않는 Minecraft 로더입니다.");
  }

  let activeStage = "게임 파일";
  const report: ProgressSink = (event) => {
    if (event.stage) activeStage = event.stage;
    progress(event);
  };
  const runtime = createDefaultNodeInstallRuntime({
    download: (files) => {
      const batchStage = activeStage;
      return downloadInstallFilesWithSystemNetwork(files, (completed, total, filePath, phase) => {
        progress({
          kind: phase === "start" ? "download" : "info",
          stage: batchStage,
          message: `받는 중 ${completed}/${total}`,
          completed,
          total,
          unit: "files",
          filePath
        });
      });
    }
  });
  const minecraft = MinecraftFolder.from(instanceDir);
  // Versions installed by an earlier launch need no metadata from Mojang, Fabric or Forge.
  const installed = InstalledVersions.forInstance(instanceDir);
  const isUsable = (versionId: string) => Version.parse(minecraft, versionId).then(() => true);
  const loaderKey = `${manifest.loader.kind}:${manifest.minecraftVersion}:${manifest.loader.version}`;
  const javaPath = await runStage(report, "Java 런타임", () => resolveRuntime(instanceDir, manifest.java, runtime, report));
  const baseVersion = await runStage(report, "Minecraft 기본 파일", () => installMinecraftBase(minecraft, manifest.minecraftVersion, runtime, report, installed));
  const version = manifest.loader.kind === "vanilla" ? baseVersion
    : manifest.loader.kind === "fabric"
      ? await runStage(report, "Fabric 설치", async () => (await installed.reuseOrInstall(loaderKey, isUsable, () => installFabric(minecraft, manifest, runtime, report))).versionId)
      : await runStage(report, manifest.loader.kind === "forge" ? "Forge 설치" : "NeoForge 설치", async () =>
        (await installed.reuseOrInstall(loaderKey, isUsable, () => installForgeFamily(minecraft, manifest, javaPath, runtime, report))).versionId);
  await runStage(report, "실행 라이브러리", () => installLaunchLibraries(minecraft, version, runtime, report));
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
    version,
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
  });
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
): Promise<void> {
  const resolved = await Version.parse(minecraft, versionId);
  const files = resolveLibraryInstallFiles(resolved.libraries, minecraft)
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (files.length === 0) return;
  progress({ kind: "info", stage: "실행 라이브러리", message: `${files.length}개 확인` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-launch-libraries", type: "files", files }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "실행 라이브러리", event)
  });
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
): Promise<string> {
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
  const assetFiles = await resolveAssetObjectInstallFiles(resolved, minecraft);
  progress({ kind: "info", stage: "게임 리소스", message: `${assetFiles.length}개 준비` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-assets", type: "files", files: assetFiles }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "게임 리소스", event)
  });
  return resolved.id;
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
