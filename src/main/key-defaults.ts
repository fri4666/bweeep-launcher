import fsp from "node:fs/promises";
import path from "node:path";
import type { ModpackManifest } from "../shared/types.js";

/**
 * Packs ship their starting key bindings in `config/yosbr/options.txt`, but the
 * YOSBR mod only writes them when the game has no options.txt at all. The
 * launcher gives every server the player's own options.txt, so a pack's
 * defaults never arrive and mods fall back to their own keys, which collide
 * (Cobblemon's summary and Xaero's world map are both M). This brings the
 * pack's keys in after the player's file is restored:
 *   - a key the player's file does not have yet gets the pack's default;
 *   - a key that shares its binding with another key moves to the pack's
 *     default, once per pack and key, so a later rebind is never undone.
 * Only `key_*` lines are touched; formatting and line endings stay as they are.
 */

const KEY_LINE = /^key_([^:\r\n]+):(.*)$/;
const PACK_VALUE = /^key\.(?:keyboard|mouse)\.[A-Za-z0-9._-]{1,40}(?::[A-Z_,+]{1,40})?$/;
const UNBOUND = "key.keyboard.unknown";
const APPLIED_FILE = "key-defaults-applied.json";

export interface KeyRepair {
  key: string;
  from: string;
  to: string;
}

export interface KeyDefaultsResult {
  text: string;
  /** Keys the player's file lacked, now set to the pack's default. */
  filled: string[];
  /** Keys moved to the pack's choice: colliding ones, and keys the manifest names. */
  repaired: KeyRepair[];
  /** Keys that were settled this time and must not be moved again (moved ones plus manifest keys already on their value). */
  settled: string[];
}

/** `key_` option name (without the prefix) → value, from an options.txt; lines that are not safe key bindings are ignored. */
export function parseKeyDefaults(text: string): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (match && PACK_VALUE.test(match[2].trim())) defaults.set(match[1], match[2].trim());
  }
  return defaults;
}

interface Entry {
  line: string;
  sep: string;
}

/**
 * Pure part: the new options.txt text for `text`, the pack's `defaults`, and the
 * keys already settled once (`applied`). `enforced` are the keys the manifest
 * names: they are put on their value once even without a collision (a new player's
 * YOSBR file has none, yet the server owner wants those exact keys), as long as
 * that value is free. Returns the same text when nothing applies.
 */
export function applyKeyDefaultsToText(text: string, defaults: ReadonlyMap<string, string>, applied: ReadonlySet<string>, enforced: ReadonlyMap<string, string> = new Map()): KeyDefaultsResult {
  const parts = text.split(/(\r\n|\n)/);
  const entries: Entry[] = [];
  for (let index = 0; index < parts.length; index += 2) entries.push({ line: parts[index], sep: parts[index + 1] ?? "" });
  // A final empty piece only marks the trailing newline.
  const trailing = entries.length > 0 && entries[entries.length - 1].line === "" && entries[entries.length - 1].sep === "";
  if (trailing) entries.pop();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  const keyIndex = new Map<string, number>();
  const value = new Map<string, string>();
  entries.forEach((entry, index) => {
    const match = KEY_LINE.exec(entry.line);
    if (!match) return;
    keyIndex.set(match[1], index);
    value.set(match[1], match[2].trim());
  });
  const setLine = (name: string, next: string) => {
    const line = `key_${name}:${next}`;
    const index = keyIndex.get(name);
    if (index === undefined) {
      if (entries.length > 0 && entries[entries.length - 1].sep === "") entries[entries.length - 1].sep = eol;
      entries.push({ line, sep: eol });
      keyIndex.set(name, entries.length - 1);
    } else {
      entries[index].line = line;
    }
    value.set(name, next);
  };
  const holders = (bound: string) => [...value].filter(([, current]) => current === bound).map(([name]) => name);

  const filled: string[] = [];
  for (const [name, pack] of defaults) {
    if (value.has(name)) continue;
    setLine(name, pack);
    filled.push(name);
  }

  const repaired: KeyRepair[] = [];
  const settled = new Set<string>();
  // A few passes, so the result does not depend on the order of the names
  // (summary leaves M before the map can take it).
  for (let pass = 0; pass < 3; pass += 1) {
    let moved = false;
    for (const [name, want] of enforced) {
      if (applied.has(name) || settled.has(name)) continue;
      const current = value.get(name);
      if (current === undefined) continue;
      if (current === want) {
        settled.add(name);
        continue;
      }
      if (want !== UNBOUND && holders(want).length > 0) continue;
      setLine(name, want);
      repaired.push({ key: name, from: current, to: want });
      settled.add(name);
      moved = true;
    }
    if (!moved) break;
  }
  for (const name of [...value.keys()]) {
    const current = value.get(name)!;
    const pack = defaults.get(name);
    if (!pack || pack === current || current === UNBOUND || current === "" || applied.has(name) || settled.has(name)) continue;
    if (holders(current).length < 2) continue;
    // The pack's choice must itself be free, or the move only shifts the clash.
    if (pack !== UNBOUND && holders(pack).length > 0) continue;
    setLine(name, pack);
    repaired.push({ key: name, from: current, to: pack });
    settled.add(name);
  }
  // A key the manifest names that was just filled in is on its value from now on.
  for (const name of filled) if (enforced.has(name)) settled.add(name);

  if (filled.length === 0 && repaired.length === 0) return { text, filled, repaired, settled: [...settled] };
  // Without a trailing newline in the original, the last line keeps none.
  const last = entries.length - 1;
  const out = entries.map((entry, index) => entry.line + (index === last && !trailing ? "" : entry.sep)).join("");
  return { text: out, filled, repaired, settled: [...settled] };
}

async function readAppliedRecord(file: string): Promise<Record<string, string[]>> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")));
  } catch {
    return {};
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const part = `${file}.bweeep-part`;
  await fsp.writeFile(part, data, "latin1");
  await fsp.rename(part, file);
}

/**
 * Applies the pack's key defaults to the instance's options.txt, right after the
 * player's shared options.txt was restored into it. The fixed file is also
 * written to the shared copy, so the fix is not lost if the game is killed before
 * it shares its own, and it follows the player to other servers.
 * Does nothing when there is no options.txt (YOSBR and the game start from scratch).
 */
export async function applyKeyDefaults(instanceDir: string, sharedSettingsDir: string, manifest: Pick<ModpackManifest, "id" | "defaultKeys">): Promise<KeyDefaultsResult | null> {
  const optionsFile = path.join(instanceDir, "options.txt");
  let current: string;
  try {
    // latin1 keeps every byte as it was; only ASCII key lines are ever edited.
    current = await fsp.readFile(optionsFile, "latin1");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const defaults = new Map<string, string>();
  try {
    for (const [name, value] of parseKeyDefaults(await fsp.readFile(path.join(instanceDir, "config", "yosbr", "options.txt"), "latin1"))) defaults.set(name, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The manifest is the server owner's own word, so it wins over the pack author's yosbr file.
  const enforced = new Map<string, string>();
  for (const [name, value] of Object.entries(manifest.defaultKeys ?? {})) {
    if (!PACK_VALUE.test(value)) continue;
    defaults.set(name, value);
    enforced.set(name, value);
  }
  if (defaults.size === 0) return null;

  const recordFile = path.join(instanceDir, ".bweeep", APPLIED_FILE);
  const record = await readAppliedRecord(recordFile);
  const result = applyKeyDefaultsToText(current, defaults, new Set(record[manifest.id] ?? []), enforced);
  if (result.text !== current) {
    await writeAtomic(optionsFile, result.text);
    const sharedOptions = path.join(sharedSettingsDir, "options.txt");
    if ((await fsp.stat(sharedOptions).catch(() => null))?.isFile()) await writeAtomic(sharedOptions, result.text);
  }
  const known = new Set(record[manifest.id] ?? []);
  if (result.settled.some((name) => !known.has(name))) {
    record[manifest.id] = [...new Set([...known, ...result.settled])].sort();
    await fsp.mkdir(path.dirname(recordFile), { recursive: true });
    await writeAtomic(recordFile, JSON.stringify(record, null, 2));
  }
  return result;
}
