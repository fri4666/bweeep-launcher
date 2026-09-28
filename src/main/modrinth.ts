import fsp from "node:fs/promises";
import path from "node:path";
import type { ModrinthHit, ModSearchResult, ModTarget, PersonalMod } from "../shared/types.js";
import { hashFile } from "./hash.js";
import { downloadInstallFilesWithSystemNetwork, fetchWithSystemNetwork } from "./system-network.js";
import { copiedPersonalMods, personalModsDir } from "./user-content.js";

// Personal convenience mods from Modrinth. Only mods that run on the client
// without the server are offered, filtered to the selected server's loader
// and Minecraft version, so they fit any server the catalog adds later.

const API = "https://api.modrinth.com/v2";
const RECORD_FILE = ".bweeep-modrinth.json";
const MAX_MOD_BYTES = 200 * 1024 * 1024;
const MAX_DEPENDENCY_DEPTH = 4;

interface InstalledRecord {
  projectId: string;
  versionId: string;
  versionNumber: string;
  title: string;
  fileName: string;
  explicit: boolean;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: string;
  files: Array<{ url: string; filename: string; primary: boolean; size: number; hashes: { sha512?: string } }>;
  dependencies: Array<{ project_id: string | null; dependency_type: string }>;
}

interface ModrinthProject {
  id: string;
  title: string;
  server_side: string;
  client_side: string;
  project_type: string;
}

let userAgent = "fri4666/bweeep-launcher (github.com/fri4666/bweeep-launcher)";

/** Modrinth asks every client to identify itself. */
export function setModrinthUserAgent(version: string): void {
  userAgent = `fri4666/bweeep-launcher/${version} (github.com/fri4666/bweeep-launcher)`;
}

export async function searchMods(target: ModTarget, query: string, offset: number): Promise<ModSearchResult> {
  requireModdable(target);
  // A pasted modpack link is refused without searching.
  const modpackLink = /modrinth\.com\/modpack\/([^/?#\s]+)/i.exec(query);
  if (modpackLink) return { hits: [], total: 0, modpacks: [decodeURIComponent(modpackLink[1])] };
  const facets = [
    ["project_type:mod"],
    [`categories:${target.loader}`],
    [`versions:${target.minecraftVersion}`],
    ["client_side:required", "client_side:optional"],
    ["server_side:optional", "server_side:unsupported"]
  ];
  const params = new URLSearchParams({
    query: query.trim().slice(0, 100),
    facets: JSON.stringify(facets),
    index: query.trim() ? "relevance" : "downloads",
    limit: "20",
    offset: String(Math.max(0, Math.min(offset, 1000)))
  });
  const [data, modpacks] = await Promise.all([
    api<{ hits: Array<Record<string, unknown>>; total_hits: number }>(`/search?${params}`),
    offset === 0 ? matchingModpacks(query) : Promise.resolve([])
  ]);
  const [installed, inPack] = await Promise.all([readRecord(target), packProjectIds(target)]);
  const blocked = new Set(target.blockedModrinthProjects);
  const hits: ModrinthHit[] = data.hits.map((hit) => {
    const projectId = String(hit.project_id);
    return {
      projectId,
      slug: String(hit.slug ?? ""),
      title: String(hit.title ?? projectId),
      description: String(hit.description ?? ""),
      iconUrl: typeof hit.icon_url === "string" && hit.icon_url.startsWith("https://") ? hit.icon_url : null,
      downloads: Number(hit.downloads ?? 0),
      status: blocked.has(projectId) ? "blocked"
        : inPack?.has(projectId) ? "inPack"
        : installed.some((mod) => mod.projectId === projectId) ? "installed"
        : "available"
    };
  });
  return { hits, total: data.total_hits, modpacks };
}

/**
 * Modpacks whose name matches the search, so a player looking for one learns
 * it cannot be downloaded instead of seeing an empty list. Whole packs replace
 * the server's pack and could not join the server, so they are never installed.
 */
async function matchingModpacks(query: string): Promise<string[]> {
  const name = query.replace(/모드\s*팩|\bmod\s*packs?\b/gi, " ").trim().slice(0, 100);
  const wanted = searchKey(name);
  if (wanted.length < 2) return [];
  const params = new URLSearchParams({ query: name, facets: JSON.stringify([["project_type:modpack"]]), limit: "5" });
  try {
    const data = await api<{ hits: Array<Record<string, unknown>> }>(`/search?${params}`);
    return data.hits
      .map((hit) => String(hit.title ?? ""))
      .filter((title) => {
        const key = searchKey(title);
        // Only packs whose whole name was typed, so "sodium" does not flag "Sodium Plus".
        return key.length >= 2 && wanted.includes(key);
      })
      .slice(0, 2);
  } catch {
    return [];
  }
}

function searchKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function listPersonalMods(target: ModTarget, checkUpdates: boolean): Promise<PersonalMod[]> {
  const record = await readRecord(target);
  return Promise.all(record.map(async (mod) => {
    const latest = checkUpdates ? await latestVersion(mod.projectId, target).catch(() => null) : null;
    return {
      projectId: mod.projectId,
      title: mod.title,
      versionNumber: mod.versionNumber,
      fileName: mod.fileName,
      explicit: mod.explicit,
      ...(latest && latest.id !== mod.versionId ? { update: latest.version_number } : {})
    };
  }));
}

export async function installMod(target: ModTarget, projectId: string): Promise<PersonalMod[]> {
  requireModdable(target);
  const record = await readRecord(target);
  const inPack = await packProjectIds(target);
  // Without an installed pack we cannot tell which mods it already ships, and a
  // second copy of the same mod stops the game from starting.
  if (!inPack) throw new Error("이 서버로 게임을 한 번 시작한 뒤에 모드를 추가해 주세요. 서버 팩에 이미 있는 모드를 확인해야 해요.");
  const blocked = new Set(target.blockedModrinthProjects);
  const directory = personalModsDir(target.instanceRoot, target.loader, target.minecraftVersion);

  const install = async (id: string, explicit: boolean, depth: number): Promise<void> => {
    requireProjectId(id);
    if (blocked.has(id)) throw new Error("이 서버에서 쓰지 않기로 한 모드라 설치할 수 없어요.");
    if (inPack.has(id)) return;
    const existing = record.find((mod) => mod.projectId === id);
    if (existing) {
      if (explicit) existing.explicit = true;
      return;
    }
    if (depth > MAX_DEPENDENCY_DEPTH) throw new Error("필요한 모드가 너무 많이 이어져 있어 설치를 멈췄어요.");
    const project = await api<ModrinthProject>(`/project/${id}`);
    if (project.project_type === "modpack") throw new Error(`${project.title}은(는) 모드팩이라 통째로 받을 수 없어요. 편의 모드만 하나씩 설치할 수 있어요.`);
    if (project.project_type !== "mod") throw new Error(`${project.title}은(는) 모드가 아니에요.`);
    if (project.server_side === "required") {
      throw new Error(`${project.title}은(는) 서버에도 설치해야 해서 개인 모드로 쓸 수 없어요.`);
    }
    const version = await latestVersion(id, target);
    if (!version) throw new Error(`${project.title}에는 ${loaderName(target)} ${target.minecraftVersion}용 파일이 없어요.`);
    for (const dependency of version.dependencies) {
      const conflict = dependency.dependency_type === "incompatible" && dependency.project_id
        && (inPack.has(dependency.project_id) || record.some((mod) => mod.projectId === dependency.project_id));
      if (conflict) throw new Error(`${project.title}은(는) 이미 있는 다른 모드와 함께 쓸 수 없어요.`);
    }
    const file = pickFile(version);
    await downloadInstallFilesWithSystemNetwork([{
      path: path.join(directory, file.filename),
      urls: [file.url],
      size: file.size,
      checksum: { algorithm: "sha512", value: file.hashes.sha512! }
    }]);
    record.push({ projectId: id, versionId: version.id, versionNumber: version.version_number, title: project.title, fileName: file.filename, explicit });
    await writeRecord(target, record);
    for (const dependency of version.dependencies) {
      if (dependency.dependency_type === "required" && dependency.project_id) await install(dependency.project_id, false, depth + 1);
    }
  };

  await fsp.mkdir(directory, { recursive: true });
  await install(projectId, true, 0);
  return listPersonalMods(target, false);
}

export async function updateMod(target: ModTarget, projectId: string): Promise<PersonalMod[]> {
  requireProjectId(projectId);
  const record = await readRecord(target);
  const current = record.find((mod) => mod.projectId === projectId);
  if (!current) throw new Error("설치된 모드가 아니에요.");
  const version = await latestVersion(projectId, target);
  if (!version || version.id === current.versionId) return listPersonalMods(target, false);
  const file = pickFile(version);
  const directory = personalModsDir(target.instanceRoot, target.loader, target.minecraftVersion);
  await downloadInstallFilesWithSystemNetwork([{
    path: path.join(directory, file.filename),
    urls: [file.url],
    size: file.size,
    checksum: { algorithm: "sha512", value: file.hashes.sha512! }
  }]);
  if (file.filename !== current.fileName) await fsp.rm(path.join(directory, current.fileName), { force: true });
  Object.assign(current, { versionId: version.id, versionNumber: version.version_number, fileName: file.filename });
  await writeRecord(target, record);
  return listPersonalMods(target, false);
}

/** Removes a mod and any dependency no other personal mod still needs. */
export async function removeMod(target: ModTarget, projectId: string): Promise<PersonalMod[]> {
  requireProjectId(projectId);
  const directory = personalModsDir(target.instanceRoot, target.loader, target.minecraftVersion);
  let record = await readRecord(target);
  const removed = record.find((mod) => mod.projectId === projectId);
  if (!removed) return listPersonalMods(target, false);
  record = record.filter((mod) => mod !== removed);
  await fsp.rm(path.join(directory, removed.fileName), { force: true });
  // Dependencies are looked up again because the record does not keep the graph.
  const needed = new Set<string>();
  for (const mod of record.filter((item) => item.explicit)) {
    needed.add(mod.projectId);
    const version = await api<ModrinthVersion>(`/version/${mod.versionId}`).catch(() => null);
    for (const dependency of version?.dependencies ?? []) {
      if (dependency.dependency_type === "required" && dependency.project_id) needed.add(dependency.project_id);
    }
  }
  for (const orphan of record.filter((mod) => !mod.explicit && !needed.has(mod.projectId))) {
    await fsp.rm(path.join(directory, orphan.fileName), { force: true });
  }
  record = record.filter((mod) => mod.explicit || needed.has(mod.projectId));
  await writeRecord(target, record);
  return listPersonalMods(target, false);
}

async function latestVersion(projectId: string, target: ModTarget): Promise<ModrinthVersion | null> {
  const params = new URLSearchParams({
    loaders: JSON.stringify([target.loader]),
    game_versions: JSON.stringify([target.minecraftVersion])
  });
  const versions = await api<ModrinthVersion[]>(`/project/${projectId}/version?${params}`);
  return versions.find((version) => version.version_type === "release") ?? versions[0] ?? null;
}

function pickFile(version: ModrinthVersion): ModrinthVersion["files"][number] {
  const file = version.files.find((item) => item.primary) ?? version.files[0];
  if (
    !file || !/^https:\/\/cdn\.modrinth\.com\//.test(file.url) || !/^[A-Za-z0-9._+\-() ]{1,128}\.jar$/.test(file.filename) ||
    !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_MOD_BYTES || !/^[a-f0-9]{128}$/.test(file.hashes.sha512 ?? "")
  ) {
    throw new Error("Modrinth 파일 정보가 올바르지 않아 설치하지 않았어요.");
  }
  return file;
}

/**
 * Projects the server pack already installs, including the launcher's bundled
 * mods, found by hashing the instance's own jars. Null before the first launch.
 */
async function packProjectIds(target: ModTarget): Promise<Set<string> | null> {
  const instanceDir = path.join(target.instanceRoot, target.packId);
  const modsDir = path.join(instanceDir, "mods");
  const personal = new Set(await copiedPersonalMods(instanceDir));
  let names: string[];
  try {
    names = (await fsp.readdir(modsDir)).filter((name) => name.endsWith(".jar") && !personal.has(name));
  } catch {
    return null;
  }
  if (names.length === 0) return new Set();
  const hashes = await Promise.all(names.map((name) => hashFile(path.join(modsDir, name), "sha512")));
  const found = await api<Record<string, { project_id: string }>>("/version_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes, algorithm: "sha512" })
  });
  return new Set(Object.values(found).map((version) => version.project_id));
}

async function readRecord(target: ModTarget): Promise<InstalledRecord[]> {
  const file = path.join(personalModsDir(target.instanceRoot, target.loader, target.minecraftVersion), RECORD_FILE);
  try {
    const value: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    return Array.isArray(value) ? value.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function writeRecord(target: ModTarget, record: InstalledRecord[]): Promise<void> {
  const file = path.join(personalModsDir(target.instanceRoot, target.loader, target.minecraftVersion), RECORD_FILE);
  await fsp.writeFile(`${file}.part`, JSON.stringify(record, null, 2), "utf8");
  await fsp.rename(`${file}.part`, file);
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithSystemNetwork(`${API}${pathname}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), "User-Agent": userAgent },
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) throw new Error("Modrinth에서 모드를 찾지 못했어요.");
  if (!response.ok) throw new Error(`Modrinth 응답 오류예요. (${response.status})`);
  return await response.json() as T;
}

function requireModdable(target: ModTarget): void {
  if (target.loader === "vanilla") throw new Error("이 서버는 모드를 쓰지 않는 바닐라 클라이언트예요.");
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(target.minecraftVersion)) throw new Error("Minecraft 버전 정보가 올바르지 않아요.");
}

function requireProjectId(id: string): void {
  if (!/^[A-Za-z0-9]{8}$/.test(id)) throw new Error("모드 정보가 올바르지 않아요.");
}

function loaderName(target: ModTarget): string {
  return { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", vanilla: "바닐라" }[target.loader];
}

function isRecord(value: unknown): value is InstalledRecord {
  const mod = value as Partial<InstalledRecord> | null;
  return Boolean(mod) && typeof mod!.projectId === "string" && typeof mod!.versionId === "string" &&
    typeof mod!.fileName === "string" && !mod!.fileName.includes("/") && !mod!.fileName.includes("\\") &&
    typeof mod!.title === "string" && typeof mod!.versionNumber === "string" && typeof mod!.explicit === "boolean";
}
