import { nativeImage } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import * as yauzl from "yauzl";
import type { SkinLibraryEntry, SkinModel } from "../shared/types.js";
import { hashBytes } from "./hash.js";

/** Same limit as the server and the storage bucket. */
const MAX_SKIN_BYTES = 64 * 1024;
const LIBRARY_FILE = "library.json";

interface StoredEntry {
  id: string;
  name: string;
  model: SkinModel;
  addedAt: string;
}

export interface DefaultSkin {
  name: string;
  model: SkinModel;
  dataUrl: string;
}

/**
 * Checks what every Minecraft version since 1.8 can render: a 64x64 or legacy
 * 64x32 PNG. The arm model is guessed the way the game artists lay it out:
 * slim (Alex) skins leave the outer arm column transparent.
 */
export function inspectSkin(png: Buffer): { model: SkinModel } {
  if (png.length === 0 || png.length > MAX_SKIN_BYTES) throw new Error("스킨 파일은 64KB 이하의 PNG여야 합니다.");
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("PNG 이미지를 읽지 못했습니다.");
  const { width, height } = image.getSize();
  if (width !== 64 || (height !== 64 && height !== 32)) throw new Error("스킨은 64×64 또는 64×32 크기여야 합니다.");
  if (height === 32) return { model: "default" };
  const bitmap = image.toBitmap();
  const alpha = (x: number, y: number) => bitmap[(y * width + x) * 4 + 3];
  let slim = true;
  for (let y = 20; y < 32 && slim; y += 1) slim = alpha(54, y) === 0 && alpha(55, y) === 0;
  return { model: slim ? "slim" : "default" };
}

export class SkinLibrary {
  constructor(private readonly root: string) {}

  async list(): Promise<SkinLibraryEntry[]> {
    const entries = await this.readIndex();
    const listed = await Promise.all(entries.map(async (entry) => {
      try {
        return { ...entry, dataUrl: toDataUrl(await fsp.readFile(this.file(entry.id))) };
      } catch {
        return null;
      }
    }));
    return listed.filter((entry): entry is SkinLibraryEntry => entry !== null);
  }

  /** Adds a PNG; the id is its content hash, which is also the server's texture name. */
  async add(png: Buffer, name: string, model?: SkinModel): Promise<StoredEntry> {
    const inspected = inspectSkin(png);
    const id = hashBytes("sha256", png);
    const entries = await this.readIndex();
    const existing = entries.find((entry) => entry.id === id);
    if (existing) return existing;
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.writeFile(this.file(id), png);
    const entry: StoredEntry = { id, name: name.slice(0, 40) || "새 스킨", model: model ?? inspected.model, addedAt: new Date().toISOString() };
    await this.writeIndex([entry, ...entries]);
    return entry;
  }

  async get(id: string): Promise<{ entry: StoredEntry; png: Buffer } | null> {
    const entry = (await this.readIndex()).find((item) => item.id === requireId(id));
    if (!entry) return null;
    return { entry, png: await fsp.readFile(this.file(entry.id)) };
  }

  async setModel(id: string, model: SkinModel): Promise<void> {
    const entries = await this.readIndex();
    await this.writeIndex(entries.map((entry) => entry.id === requireId(id) ? { ...entry, model } : entry));
  }

  async remove(id: string): Promise<void> {
    const entries = await this.readIndex();
    await this.writeIndex(entries.filter((entry) => entry.id !== requireId(id)));
    await fsp.rm(this.file(id), { force: true });
  }

  private file(id: string): string {
    return path.join(this.root, `${requireId(id)}.png`);
  }

  private async readIndex(): Promise<StoredEntry[]> {
    try {
      const value: unknown = JSON.parse(await fsp.readFile(path.join(this.root, LIBRARY_FILE), "utf8"));
      return Array.isArray(value) ? value.filter(isStoredEntry) : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(entries: StoredEntry[]): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    const target = path.join(this.root, LIBRARY_FILE);
    await fsp.writeFile(`${target}.part`, JSON.stringify(entries, null, 2), "utf8");
    await fsp.rename(`${target}.part`, target);
  }
}

/**
 * Minecraft's own Steve and Alex, read from a client jar the player already
 * installed, so the launcher does not redistribute Mojang's textures.
 */
export async function findDefaultSkins(instanceRoot: string): Promise<DefaultSkin[]> {
  const wanted = new Map<string, DefaultSkin>([
    ["assets/minecraft/textures/entity/player/wide/steve.png", { name: "Steve", model: "default", dataUrl: "" }],
    ["assets/minecraft/textures/entity/player/slim/alex.png", { name: "Alex", model: "slim", dataUrl: "" }]
  ]);
  for (const jar of await clientJars(instanceRoot)) {
    try {
      const found = await readZipEntries(jar, [...wanted.keys()]);
      if (found.size === wanted.size) {
        return [...wanted].map(([entryPath, skin]) => ({ ...skin, dataUrl: toDataUrl(found.get(entryPath)!) }));
      }
    } catch {
      // Try the next installed version.
    }
  }
  return [];
}

async function clientJars(instanceRoot: string): Promise<string[]> {
  const jars: Array<{ file: string; mtime: number }> = [];
  for (const instance of await readDirNames(instanceRoot)) {
    const versionsDir = path.join(instanceRoot, instance, "versions");
    for (const version of await readDirNames(versionsDir)) {
      const file = path.join(versionsDir, version, `${version}.jar`);
      try {
        jars.push({ file, mtime: (await fsp.stat(file)).mtimeMs });
      } catch {
        // Loader versions have no jar of their own.
      }
    }
  }
  return jars.sort((a, b) => b.mtime - a.mtime).map((jar) => jar.file);
}

async function readDirNames(directory: string): Promise<string[]> {
  try {
    return (await fsp.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readZipEntries(file: string, names: string[]): Promise<Map<string, Buffer>> {
  const wanted = new Set(names);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("jar를 열지 못했습니다."));
      const found = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName) || entry.uncompressedSize > MAX_SKIN_BYTES) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("jar 항목을 읽지 못했습니다."));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("error", reject);
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(chunks));
            if (found.size === wanted.size) {
              zip.close();
              resolve(found);
            } else {
              zip.readEntry();
            }
          });
        });
      });
      zip.on("end", () => resolve(found));
      zip.readEntry();
    });
  });
}

export function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function requireId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("스킨 정보가 올바르지 않습니다.");
  return id;
}

function isStoredEntry(value: unknown): value is StoredEntry {
  const entry = value as Partial<StoredEntry> | null;
  return Boolean(entry) && typeof entry!.id === "string" && /^[a-f0-9]{64}$/.test(entry!.id) &&
    typeof entry!.name === "string" && (entry!.model === "default" || entry!.model === "slim") && typeof entry!.addedAt === "string";
}
