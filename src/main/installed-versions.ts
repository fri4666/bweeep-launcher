import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Game and loader versions this launcher finished installing in an instance,
 * so later launches skip the Mojang, Fabric and Forge metadata requests for
 * them. Files are still checked against their hashes on every launch.
 */
export class InstalledVersions {
  constructor(private readonly file: string) {}

  static forInstance(instanceDir: string): InstalledVersions {
    return new InstalledVersions(path.join(instanceDir, ".bweeep", "installed-versions.json"));
  }

  /**
   * The version installed for `key` when it is still usable; otherwise runs
   * `install` and remembers what it installed.
   */
  async reuseOrInstall(key: string, isUsable: (versionId: string) => Promise<boolean>, install: () => Promise<string>): Promise<{ versionId: string; reused: boolean }> {
    const known = (await this.read())[key];
    if (known && await isUsable(known).catch(() => false)) return { versionId: known, reused: true };
    const versionId = await install();
    await this.remember(key, versionId);
    return { versionId, reused: false };
  }

  async remember(key: string, versionId: string): Promise<void> {
    const entries = await this.read();
    entries[key] = versionId;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(entries, null, 2), "utf8");
    await fsp.rename(temporary, this.file);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await fsp.readFile(this.file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string" && /^[\w.+-]{1,128}$/.test(entry[1])));
    } catch {
      // Missing or damaged: everything is installed the normal way again.
      return {};
    }
  }
}
