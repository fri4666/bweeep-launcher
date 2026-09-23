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
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  resolveMinecraftVersionJsonInstallFile,
  resolveNeoForgedInstallerFile
} from "@xmcl/installer";
import type { ModpackManifest, SyncProgress } from "../shared/types.js";
import { ensureBundledClientMods, type BundledClientMod } from "./companion-mod.js";
import type { LaunchIdentity } from "./launch-identity.js";
import { describeGameExit, type GameExitResult } from "./game-exit.js";
import { createGameOutputObserver } from "./game-telemetry.js";
import { verifyRemoteConnectionLock } from "./connection-lock.js";
import { downloadInstallFilesWithSystemNetwork, fetchWithSystemNetwork } from "./system-network.js";

type ProgressSink = (event: SyncProgress) => void;

export async function installAndLaunch(
  manifest: ModpackManifest,
  instanceDir: string,
  getLaunchAuthorization: () => Promise<{ identity: LaunchIdentity; ticket: string }>,
  bundledClientMods: BundledClientMod[],
  progress: ProgressSink,
  onExit: (exit: GameExitResult) => void
): Promise<{ pid: number; version: string }> {
  if (!["vanilla", "neoforge", "forge", "fabric"].includes(manifest.loader.kind)) {
    throw new Error("지원하지 않는 Minecraft 로더입니다.");
  }

  let activeStage = "게임 파일";
  let downloadBatch = 0;
  const report: ProgressSink = (event) => {
    if (event.stage) activeStage = event.stage;
    progress(event);
  };
  const runtime = createDefaultNodeInstallRuntime({
    maxConcurrency: 2,
    download: (files) => {
      const batchStage = `${activeStage} · 다운로드 묶음 ${++downloadBatch}`;
      return downloadInstallFilesWithSystemNetwork(files, (completed, total, filePath, phase) => {
        progress({
          kind: phase === "start" ? "download" : "info",
          stage: batchStage,
          message: `${path.basename(filePath)} ${phase === "start" ? "다운로드 중" : "다운로드 완료"}`,
          completed,
          total,
          unit: "files"
        });
      });
    }
  });
  const minecraft = MinecraftFolder.from(instanceDir);
  const javaPath = await runStage(report, "Java 런타임", () => resolveRuntime(instanceDir, manifest.java, runtime, report));
  const baseVersion = await runStage(report, "Minecraft 기본 파일", () => installMinecraftBase(minecraft, manifest.minecraftVersion, runtime, report));
  const version = manifest.loader.kind === "vanilla" ? baseVersion
    : manifest.loader.kind === "fabric"
      ? await runStage(report, "Fabric 설치", () => installFabric(minecraft, manifest, runtime, report))
      : await runStage(report, manifest.loader.kind === "forge" ? "Forge 설치" : "NeoForge 설치", () => installForgeFamily(minecraft, manifest, javaPath, runtime, report));
  await runStage(report, "실행 라이브러리", () => installLaunchLibraries(minecraft, version, runtime, report));
  if (manifest.loader.kind !== "vanilla") {
    await ensureBundledClientMods(instanceDir, bundledClientMods);
  }
  const remoteLock = manifest.clientFeatures?.connectionLock;
  if (typeof remoteLock === "object") {
    await verifyRemoteConnectionLock(instanceDir, manifest);
    report({ kind: "info", stage: "서버 연결 보호", message: `${manifest.minecraftVersion} ${manifest.loader.kind} 연결 보호 모드 검증 완료` });
  }
  const quickPlayPath = path.join(instanceDir, "quickPlay", "bweeep.json");
  await fsp.mkdir(path.dirname(quickPlayPath), { recursive: true });

  report({ kind: "info", stage: "접속 인증", message: "서버 접속 인증표 준비 중" });
  const { identity, ticket: gameTicket } = await runStage(report, "접속 인증", getLaunchAuthorization);
  report({ kind: "info", stage: "게임 실행", message: "Minecraft 실행 명령을 준비하는 중" });
  const gameProcess = await launch({
    gamePath: instanceDir,
    resourcePath: instanceDir,
    javaPath,
    version,
    accessToken: identity.accessToken,
    gameProfile: { id: identity.id, name: identity.name },
    userType: "legacy",
    quickPlayMultiplayer: `${manifest.server.host}:${manifest.server.port}`,
    extraJVMArgs: typeof remoteLock === "object" ? [`-Dbweeep.targetServer=${manifest.server.host}:${manifest.server.port}`] : [],
    extraMCArgs: ["--quickPlayPath", quickPlayPath],
    extraExecOption: {
      env: { ...process.env, BWEEP_GAME_TICKET: gameTicket }
    },
    minMemory: 2048,
    maxMemory: 6144
  });
  report({ kind: "info", stage: "게임 프로세스", message: `Minecraft 프로세스 실행 중${gameProcess.pid ? ` · PID ${gameProcess.pid}` : ""} · 서버 참가 확인 전` });
  gameProcess.stdout?.on("data", createGameOutputObserver(report));
  gameProcess.stderr?.on("data", createGameOutputObserver(report));
  const watcher = createMinecraftProcessWatcher(gameProcess);
  watcher.once("minecraft-window-ready", () => {
    report({ kind: "info", stage: "게임 초기화", message: "Minecraft 클라이언트 초기화 신호 감지 · 서버 참가 확인 전" });
  });
  watcher.once("minecraft-exit", ({ code, signal, crashReport, crashReportLocation }) => {
    const exit = describeGameExit({ code, signal, crashReport, crashReportLocation });
    report({
      kind: exit.abnormal ? "error" : "info",
      stage: "게임 종료",
      message: exit.message
    });
    onExit(exit);
  });
  watcher.once("error", (error) => {
    const message = `Minecraft 프로세스를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    report({ kind: "error", stage: "게임 실행", message });
    onExit({ abnormal: true, message, code: null, signal: null, crashReportLocation: null });
  });
  return { pid: gameProcess.pid ?? 0, version: version || baseVersion };
}

async function installFabric(
  minecraft: MinecraftFolder,
  manifest: ModpackManifest,
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", stage: "Fabric", message: `Fabric ${manifest.loader.version} 설치 파일을 준비하는 중` });
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
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<void> {
  const resolved = await Version.parse(minecraft, versionId);
  const files = resolveLibraryInstallFiles(resolved.libraries, minecraft)
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (files.length === 0) return;
  progress({ kind: "info", stage: "실행 라이브러리", message: `실행 라이브러리 ${files.length}개를 확인하는 중` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-launch-libraries", type: "files", files }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "실행 라이브러리", event)
  });
}

async function runStage<T>(progress: ProgressSink, stage: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  progress({ kind: "info", stage, message: `${stage} 시작` });
  try {
    const result = await action();
    progress({ kind: "info", stage, elapsedMs: Date.now() - startedAt, message: `${stage} 완료` });
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
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  const bundled = process.platform === "win32"
    ? path.join(instanceDir, ".bweeep", "runtime", "bin", "javaw.exe")
    : path.join(instanceDir, ".bweeep", "runtime", "bin", "java");
  const candidates = [bundled, ...(await getPotentialJavaLocations())];
  for (const candidate of candidates) {
    const java = await resolveJava(candidate);
    if (java && java.majorVersion === requiredJava.majorVersion) return java.path;
  }

  progress({ kind: "info", stage: "Java 런타임", message: `Minecraft용 Java ${requiredJava.majorVersion}을 찾지 못해 다운로드를 시작합니다.` });
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
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", stage: "게임 정보", message: `Minecraft ${minecraftVersion} 버전 정보를 확인하는 중` });
  const entry = (await getVersionList({ fetch: fetchWithSystemNetwork })).versions.find((item) => item.id === minecraftVersion);
  if (!entry) throw new Error(`Minecraft ${minecraftVersion} 정보를 찾지 못했습니다.`);
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-version", type: "files", files: [resolveMinecraftVersionJsonInstallFile(entry, minecraft)] }] }, runtime);
  const resolved = await Version.parse(minecraft, minecraftVersion);
  const baseFiles = [
    resolveMinecraftJarInstallFile(resolved),
    ...resolveLibraryInstallFiles(resolved.libraries, minecraft),
    ...resolveAssetMetadataInstallFiles(resolved, minecraft)
  ].filter((file): file is NonNullable<typeof file> => Boolean(file));
  progress({ kind: "info", stage: "라이브러리", message: `게임 파일과 라이브러리 ${baseFiles.length}개를 준비하는 중` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-base", type: "files", files: baseFiles }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "라이브러리", event)
  });
  const assetFiles = await resolveAssetObjectInstallFiles(resolved, minecraft);
  progress({ kind: "info", stage: "게임 리소스", message: `게임 리소스 ${assetFiles.length}개를 준비하는 중` });
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-assets", type: "files", files: assetFiles }] }, runtime, {
    onEvent: (event) => publishInstallerEvent(progress, "게임 리소스", event)
  });
  return resolved.id;
}

async function installForgeFamily(
  minecraft: MinecraftFolder,
  manifest: ModpackManifest,
  javaPath: string,
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  const project = manifest.loader.kind === "forge" ? "forge" : "neoforge";
  const stage = project === "forge" ? "Forge" : "NeoForge";
  progress({ kind: "info", stage, message: `${stage} ${manifest.loader.version} 설치 파일을 준비하는 중` });
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

function publishInstallerEvent(progress: ProgressSink, stage: string, event: unknown): void {
  progress({ kind: "info", stage, message: `${stage}: ${installEventDetail(event)}` });
}

function installEventDetail(event: unknown): string {
  if (!event || typeof event !== "object") return "설치 작업 처리 중";
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "작업";
  const target = [record.filePath, record.path, record.file, record.id, record.name]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return target ? `${type} · ${target}` : type;
}
