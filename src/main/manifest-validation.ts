import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";

export function assertManifest(manifest: ModpackManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.id ||
    !manifest.minecraftVersion ||
    !manifest.loader?.kind ||
    !["vanilla", "fabric", "neoforge", "forge"].includes(manifest.loader.kind) ||
    !Number.isSafeInteger(manifest.java?.majorVersion) ||
    manifest.java.majorVersion < 8 ||
    !manifest.java.component
  ) {
    throw new Error("지원하지 않는 manifest 형식입니다.");
  }
  if (manifest.serverLoader && !["vanilla", "fabric", "neoforge", "forge", "paper", "folia"].includes(manifest.serverLoader.kind)) {
    throw new Error("지원하지 않는 서버 로더 정보입니다.");
  }
  if (manifest.clientFeatures) {
    const lock = manifest.clientFeatures.connectionLock;
    if (typeof lock !== "boolean" && (
      !lock || lock.protocolVersion !== 1 ||
      lock.path !== "mods/bweeep-connection-lock.jar" ||
      !/^[a-f0-9]{64}$/i.test(lock.sha256) ||
      lock.minecraftVersion !== manifest.minecraftVersion ||
      lock.loaderKind !== manifest.loader.kind ||
      !manifest.files.some((file) => file.path === lock.path && file.sha256?.toLowerCase() === lock.sha256.toLowerCase())
    )) {
      throw new Error("선택 서버 연결 보호 모드 정보가 올바르지 않습니다.");
    }
  }
  if (manifest.gameAuth !== undefined && manifest.gameAuth !== "offline" && manifest.gameAuth !== "yggdrasil") {
    throw new Error("지원하지 않는 서버 인증 방식입니다.");
  }
  if (manifest.blockedModrinthProjects !== undefined && (
    !Array.isArray(manifest.blockedModrinthProjects) ||
    !manifest.blockedModrinthProjects.every((id) => typeof id === "string" && /^[A-Za-z0-9]{8}$/.test(id))
  )) {
    throw new Error("차단 모드 목록 형식이 올바르지 않습니다.");
  }
  // The same bounds as isMemoryMb in shared/game-memory. This file has no runtime
  // imports so scripts/publish-manifest.mjs can load it straight from source.
  const memoryMb = manifest.recommendedMemoryMb;
  if (memoryMb !== undefined && !(Number.isSafeInteger(memoryMb) && memoryMb >= 1024 && memoryMb <= 65536)) {
    throw new Error("권장 메모리 값이 올바르지 않습니다.");
  }
  if (manifest.defaultKeys !== undefined) {
    const keys = manifest.defaultKeys as unknown;
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || !Object.entries(keys).every(([name, value]) =>
      /^[A-Za-z0-9_.-]{1,96}$/.test(name) && typeof value === "string" && /^key\.(?:keyboard|mouse)\.[a-z0-9._-]{1,40}$/.test(value))) {
      throw new Error("기본 키 설정 형식이 올바르지 않습니다.");
    }
  }
  if (manifest.mrpack && (!/^https:\/\//.test(manifest.mrpack.url) || !Number.isSafeInteger(manifest.mrpack.size) || manifest.mrpack.size < 1 || !/^[a-f0-9]{128}$/i.test(manifest.mrpack.sha512))) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
  }
  if (manifest.initialInstallBundle !== undefined) {
    const bundle = manifest.initialInstallBundle;
    if (!bundle || typeof bundle !== "object" || !/^https:\/\//.test(bundle.url) || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || !/^[a-f0-9]{128}$/i.test(bundle.sha512)) {
      throw new Error("초기 설치 묶음 정보가 올바르지 않습니다.");
    }
    if (bundle.paths !== undefined) {
      if (!Array.isArray(bundle.paths) || bundle.paths.length < 1 || bundle.paths.length > 20_000 ||
        !Array.from(bundle.paths).every(isInitialInstallBundlePath) ||
        new Set(bundle.paths.map((name) => name.toLowerCase())).size !== bundle.paths.length) {
        throw new Error("초기 설치 묶음 파일 목록이 올바르지 않습니다.");
      }
      // The mrpack index is validated after it is resolved by syncModpack.
      if (!manifest.mrpack && bundle.paths.some((name) => !manifest.files.some((file) => file.path === name && isInitialInstallBundlePath(file.path)))) {
        throw new Error("초기 설치 묶음 파일이 현재 모드팩 목록에 없습니다.");
      }
    }
  }
  for (const file of manifest.files) {
    if (
      !file.path ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]+/).includes("..") ||
      !file.url ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !((typeof file.sha256 === "string" && /^[a-f0-9]{64}$/i.test(file.sha256)) || (typeof file.sha512 === "string" && /^[a-f0-9]{128}$/i.test(file.sha512)))
    ) {
      throw new Error("manifest 파일 정보가 올바르지 않습니다.");
    }
  }
}

/** Immutable managed archives only; shared by manifest and ZIP validation. */
export function isInitialInstallBundlePath(value: unknown): value is string {
  if (typeof value !== "string" || /[\\<>:"|?*\u0000-\u001f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  if (/^mods\/CrashAssistant-[^/]*\.jar$/i.test(value)) return false;
  return /^mods\/.+\.jar$/i.test(value) || /^(resourcepacks|shaderpacks)\/.+\.zip$/i.test(value);
}
