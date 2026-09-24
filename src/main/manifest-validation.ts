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
  if (manifest.mrpack && (!/^https:\/\//.test(manifest.mrpack.url) || !Number.isSafeInteger(manifest.mrpack.size) || manifest.mrpack.size < 1 || !/^[a-f0-9]{128}$/i.test(manifest.mrpack.sha512))) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
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
