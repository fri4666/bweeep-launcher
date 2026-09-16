import path from "node:path";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { MinecraftFolder, Version, createMinecraftProcessWatcher, launch } from "@xmcl/core";
import {
  createDefaultNodeInstallRuntime,
  createJavaRuntimeInstallWorkflow,
  createModernForgeInstallWorkflow,
  executeInstallManifest,
  executeInstallWorkflow,
  getPotentialJavaLocations,
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
import { ensureCompanionMod } from "./companion-mod.js";
import { downloadInstallFilesWithSystemNetwork, fetchWithSystemNetwork } from "./system-network.js";

type ProgressSink = (event: SyncProgress) => void;

export async function installAndLaunch(
  manifest: ModpackManifest,
  instanceDir: string,
  identity: LaunchIdentity,
  gameTicket: string,
  companionModPath: string,
  progress: ProgressSink,
  onExit: () => void
): Promise<{ pid: number; version: string }> {
  if (manifest.loader.kind !== "neoforge") {
    throw new Error("현재 붸에엡은 NeoForge 모드팩 실행을 지원합니다.");
  }

  const runtime = createDefaultNodeInstallRuntime({
    maxConcurrency: 2,
    download: downloadInstallFilesWithSystemNetwork
  });
  const minecraft = MinecraftFolder.from(instanceDir);
  const javaPath = await resolveRuntime(instanceDir, runtime, progress);
  const baseVersion = await installMinecraftBase(minecraft, manifest.minecraftVersion, runtime, progress);
  const version = await installNeoForge(minecraft, manifest, javaPath, runtime, progress);
  await ensureCompanionMod(instanceDir, companionModPath);
  const quickPlayPath = path.join(instanceDir, "quickPlay", "bweeep.json");
  await fsp.mkdir(path.dirname(quickPlayPath), { recursive: true });

  progress({ kind: "info", message: "Minecraft 실행 중" });
  const gameProcess = await launch({
    gamePath: instanceDir,
    resourcePath: instanceDir,
    javaPath,
    version,
    accessToken: identity.accessToken,
    gameProfile: { id: identity.id, name: identity.name },
    userType: "legacy",
    quickPlayMultiplayer: `${manifest.server.host}:${manifest.server.port}`,
    extraMCArgs: ["--quickPlayPath", quickPlayPath],
    extraExecOption: {
      env: { ...process.env, BWEEP_GAME_TICKET: gameTicket }
    },
    minMemory: 2048,
    maxMemory: 6144
  });
  const watcher = createMinecraftProcessWatcher(gameProcess);
  watcher.once("minecraft-exit", ({ code, crashReport }) => {
    progress({
      kind: crashReport || (typeof code === "number" && code !== 0) ? "error" : "info",
      message: crashReport || `Minecraft가 종료되었습니다. (코드 ${code ?? "없음"})`
    });
    onExit();
  });
  watcher.once("error", () => onExit());
  return { pid: gameProcess.pid ?? 0, version: version || baseVersion };
}

export interface LaunchIdentity {
  id: string;
  name: string;
  accessToken: string;
}

export function createOfflineLaunchIdentity(accountId: string, displayName: string): LaunchIdentity {
  const digest = crypto.createHash("md5").update(`OfflinePlayer:${accountId}`).digest("hex");
  const readable = displayName.normalize("NFKD").replace(/[^A-Za-z0-9_]/g, "").slice(0, 11);
  return {
    id: digest,
    name: readable.length >= 3 ? `${readable}_${digest.slice(0, 4)}` : `Bweep_${digest.slice(0, 10)}`,
    accessToken: crypto.randomUUID().replaceAll("-", "")
  };
}

async function resolveRuntime(instanceDir: string, runtime: ReturnType<typeof createDefaultNodeInstallRuntime>, progress: ProgressSink): Promise<string> {
  const bundled = process.platform === "win32"
    ? path.join(instanceDir, ".bweeep", "runtime", "bin", "javaw.exe")
    : path.join(instanceDir, ".bweeep", "runtime", "bin", "java");
  const candidates = [bundled, ...(await getPotentialJavaLocations())];
  for (const candidate of candidates) {
    const java = await resolveJava(candidate);
    if (java && java.majorVersion >= 21) return java.path;
  }

  progress({ kind: "info", message: "Minecraft용 Java 21을 준비하는 중" });
  const platform = process.platform === "win32"
    ? process.arch === "arm64" ? "windows-arm64" : "windows-x64"
    : process.platform === "darwin" ? process.arch === "arm64" ? "mac-os-arm64" : "mac-os"
    : "linux";
  const response = await fetchWithSystemNetwork("https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json");
  if (!response.ok) throw new Error("Java 런타임 목록을 가져오지 못했습니다.");
  const catalog = await response.json() as Record<string, Record<string, Array<unknown>>>;
  const targets = catalog[platform]?.["java-runtime-delta"];
  if (!targets?.[0]) throw new Error("이 PC용 Java 21 런타임을 찾지 못했습니다.");
  await executeInstallWorkflow(
    createJavaRuntimeInstallWorkflow({ target: targets[0] as Parameters<typeof createJavaRuntimeInstallWorkflow>[0]["target"], destination: path.dirname(path.dirname(bundled)) }),
    runtime,
    { onEvent: (event) => progress({ kind: "info", message: `Java 준비: ${event.type}` }) }
  );
  const java = await resolveJava(bundled);
  if (!java || java.majorVersion < 21) throw new Error("Java 21 설치를 확인하지 못했습니다.");
  return java.path;
}

async function installMinecraftBase(
  minecraft: MinecraftFolder,
  minecraftVersion: string,
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", message: `Minecraft ${minecraftVersion} 준비 중` });
  const entry = (await getVersionList({ fetch: fetchWithSystemNetwork })).versions.find((item) => item.id === minecraftVersion);
  if (!entry) throw new Error(`Minecraft ${minecraftVersion} 정보를 찾지 못했습니다.`);
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-version", type: "files", files: [resolveMinecraftVersionJsonInstallFile(entry, minecraft)] }] }, runtime);
  const resolved = await Version.parse(minecraft, minecraftVersion);
  const baseFiles = [
    resolveMinecraftJarInstallFile(resolved),
    ...resolveLibraryInstallFiles(resolved.libraries, minecraft),
    ...resolveAssetMetadataInstallFiles(resolved, minecraft)
  ].filter((file): file is NonNullable<typeof file> => Boolean(file));
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-base", type: "files", files: baseFiles }] }, runtime, {
    onEvent: (event) => progress({ kind: "info", message: `Minecraft 준비: ${event.type}` })
  });
  const assetFiles = await resolveAssetObjectInstallFiles(resolved, minecraft);
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: "minecraft-assets", type: "files", files: assetFiles }] }, runtime, {
    onEvent: (event) => progress({ kind: "info", message: `게임 리소스 준비: ${event.type}` })
  });
  return resolved.id;
}

async function installNeoForge(
  minecraft: MinecraftFolder,
  manifest: ModpackManifest,
  javaPath: string,
  runtime: ReturnType<typeof createDefaultNodeInstallRuntime>,
  progress: ProgressSink
): Promise<string> {
  progress({ kind: "info", message: `NeoForge ${manifest.loader.version} 준비 중` });
  const installer = await resolveNeoForgedInstallerFile("neoforge", manifest.loader.version, minecraft, {});
  const installed = await executeInstallWorkflow(
    createModernForgeInstallWorkflow({
      id: `neoforge-${manifest.loader.version}`,
      minecraft,
      minecraftVersion: manifest.minecraftVersion,
      installer: installer.file,
      artifactVersion: manifest.loader.version,
      java: javaPath,
      installOptions: {},
      side: "client"
    }),
    runtime,
    { onEvent: (event) => progress({ kind: "info", message: `NeoForge 준비: ${event.type}` }) }
  );
  return installed.version;
}
