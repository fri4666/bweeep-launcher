import { releaseAssetUrl, readReleaseRange } from "./github-delivery.js";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { UPDATE_CHUNK_SIZE, UPDATE_STORAGE_ROOT } from "./file-update-manifest.js";

export interface InstallerDescriptor {
  schema: 1;
  version: string;
  arch: "x64" | "arm64";
  size: number;
  sha256: string;
  chunkSize: number;
  chunks: number;
  signature: string;
}

export interface PreparedInstaller {
  path: string;
  sha256: string;
  version: string;
  arch: "x64" | "arm64";
}

/** A protected machine installation keeps its location and uses the NSIS/UAC boundary. */
export function isProtectedInstallRoot(root: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (!path.win32.isAbsolute(root)) return false;
  const resolved = path.win32.resolve(root).toLowerCase();
  return [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.ProgramW6432].some((base) => {
    if (!base || !path.win32.isAbsolute(base)) return false;
    const prefix = path.win32.resolve(base).toLowerCase().replace(/\\+$/, "");
    return resolved === prefix || resolved.startsWith(`${prefix}\\`);
  });
}

export function verifyInstallerDescriptor(value: unknown, publicKey: string, version: string, arch: "x64" | "arm64"): InstallerDescriptor {
  const descriptor = value as InstallerDescriptor | null;
  if (!descriptor || descriptor.schema !== 1 || descriptor.version !== version || descriptor.arch !== arch ||
      !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version) ||
      !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > 2_000_000_000 ||
      descriptor.chunkSize !== UPDATE_CHUNK_SIZE || descriptor.chunks !== Math.ceil(descriptor.size / UPDATE_CHUNK_SIZE) ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) || typeof descriptor.signature !== "string") {
    throw new Error("설치 파일 목록 형식이 잘못되었습니다.");
  }
  const { schema, size, sha256, chunkSize, chunks } = descriptor;
  const payload = { schema, version, arch, size, sha256, chunkSize, chunks };
  if (!verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(publicKey), Buffer.from(descriptor.signature, "base64"))) {
    throw new Error("설치 파일 서명이 일치하지 않습니다.");
  }
  return descriptor;
}

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`설치 파일을 받지 못했습니다. (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > maximum) throw new Error("설치 파일 응답 크기가 올바르지 않습니다.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function prepareProtectedInstaller(options: {
  version: string;
  arch: "x64" | "arm64";
  publicKey: string;
  stage: string;
  signal: AbortSignal;
  fetcher: (url: string, options?: RequestInit) => Promise<Response>;
  progress: (received: number, total: number) => void;
}): Promise<PreparedInstaller> {
  const { version, arch, signal, fetcher } = options;
  // Bind to the already verified update, never to a mutable latest/stable installer pointer.
  const descriptorResponse = await fetcher(`${UPDATE_STORAGE_ROOT}/installers/${encodeURIComponent(version)}/${arch}.json`, {
    cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  });
  const descriptor = verifyInstallerDescriptor(JSON.parse((await boundedBytes(descriptorResponse, 16_384)).toString("utf8")), options.publicKey, version, arch);
  const destination = path.join(options.stage, `Bweeep-Setup-${version}-${arch}-${randomUUID()}.exe`);
  const temporary = `${destination}.part`;
  const hash = createHash("sha256");
  let received = 0;
  const githubUrl = releaseAssetUrl(version, `Bweeep-Setup-${version}${arch === "arm64" ? "-arm64" : ""}.exe`);
  let useGithub = true;
  await fsp.mkdir(options.stage, { recursive: true });
  const output = await fsp.open(temporary, "wx");
  try {
    options.progress(0, descriptor.size);
    for (let part = 0; part < descriptor.chunks; part++) {
      const expected = Math.min(UPDATE_CHUNK_SIZE, descriptor.size - received);
      const end = received + expected - 1;
      let response: Response | undefined;
      if (useGithub) {
        response = await fetcher(githubUrl, {
          headers: { Range: `bytes=${received}-${end}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
        });
        if (part === 0 && response.status === 404) {
          await response.body?.cancel();
          useGithub = false;
        }
      }
      if (!useGithub) response = await fetcher(`${UPDATE_STORAGE_ROOT}/installers/${version}/${arch}/${descriptor.sha256}/part-${String(part).padStart(4, "0")}.bin`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
      });
      const bytes = useGithub ? await readReleaseRange(response!, received, end, descriptor.size) : await boundedBytes(response!, expected);
      if (bytes.length !== expected) throw new Error("설치 파일 조각 크기가 올바르지 않습니다.");
      hash.update(bytes);
      await output.writeFile(bytes);
      received += bytes.length;
      options.progress(received, descriptor.size);
    }
    if (received !== descriptor.size || hash.digest("hex") !== descriptor.sha256) throw new Error("설치 파일 검증에 실패했습니다.");
    await output.close();
    await fsp.rename(temporary, destination);
    return { path: destination, sha256: descriptor.sha256, version, arch };
  } finally {
    await output.close().catch(() => undefined);
    await fsp.rm(temporary, { force: true });
  }
}

// This wrapper stays UNELEVATED. Only the verified NSIS executable receives RunAs.
// Its read handle denies writes/deletion through the UAC wait and rechecks the full hash.
export const PROTECTED_INSTALLER_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$locked = $null
try {
  $installer = [IO.Path]::GetFullPath($request.installer)
  $root = [IO.Path]::GetFullPath($request.root).TrimEnd([char]92)
  if ($installer -match '[\x00-\x1f"]' -or $root -match '[\x00-\x1f"]' -or $request.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid installer request' }
  $locked = [IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($hasher.ComputeHash($locked)).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
  if ($actual -ne $request.sha256) { throw 'Installer hash mismatch' }
  $arguments = '/S --updated --force-run /allusers /D=' + $root
  $started = Start-Process -FilePath $installer -Verb RunAs -ArgumentList $arguments -PassThru
  if ($null -eq $started) { throw 'Installer did not start' }
  [Console]::Out.WriteLine('BWEEP_INSTALLER_STARTED')
} catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  if ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) {
    [Console]::Out.WriteLine('BWEEP_INSTALLER_CANCELLED')
    exit 0
  }
  [Console]::Error.WriteLine('Installer could not start')
  exit 1
} finally {
  if ($locked) { $locked.Dispose() }
}
`;

export function launchProtectedInstaller(installer: PreparedInstaller, root: string, options: {
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
} = {}): Promise<"started" | "cancelled"> {
  const environment = options.environment ?? process.env;
  if (!isProtectedInstallRoot(root, environment) || !path.win32.isAbsolute(installer.path) || /[\x00-\x1f"]/u.test(root + installer.path) ||
      !/^[a-f0-9]{64}$/.test(installer.sha256) || !environment.SystemRoot || !path.win32.isAbsolute(environment.SystemRoot)) {
    return Promise.reject(new Error("설치 파일 실행 경로가 잘못되었습니다."));
  }
  const powershell = path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = (options.spawnProcess ?? spawn)(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PROTECTED_INSTALLER_COMMAND, "utf16le").toString("base64")], {
    detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (result?: "started" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (result) resolve(result);
      else reject(new Error("관리자 승인 후 설치 파일을 실행하지 못했습니다."));
    };
    const timer = setTimeout(() => { child.kill(); finish(); }, 5 * 60_000);
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4_096) return finish();
      for (const line of output.split(/\r?\n/).slice(0, -1)) {
        if (line === "BWEEP_INSTALLER_STARTED") return finish("started");
        if (line === "BWEEP_INSTALLER_CANCELLED") return finish("cancelled");
      }
    });
    child.stdin?.on("error", () => finish());
    child.stdin?.end(JSON.stringify({ installer: installer.path, sha256: installer.sha256, root }));
  });
}
