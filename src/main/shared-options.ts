import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The player's options.txt follows them from server to server through one
 * shared copy (`.bweeep-user-content/settings/options.txt`). That copy only
 * ever reaches the shared store when a game closes normally, so it can be
 * missing or stale, and a game that starts without one lets YOSBR write the
 * pack's own defaults (a pack that sets master 0.5 / music 0.25 turns the
 * player's volumes down). Before the launcher restores the shared file it
 * makes sure the file carries the player's settings:
 *   - no usable shared file: it is seeded from the newest options.txt of the
 *     player's other servers;
 *   - a shared file without volume lines: only the missing `soundCategory_*`
 *     lines are added from the newest other server that has them;
 *   - nothing anywhere: nothing is invented, the pack and the game start from
 *     their own defaults.
 * A shared file that already has volume lines is never touched.
 */

const SOUND_LINE = /^soundCategory_([A-Za-z0-9_]+):(.*)$/;
const SOUND_VALUE = /^-?\d+(?:\.\d+)?$/;
const OPTION_LINE = /^[A-Za-z0-9_.]+:/m;

export type OptionsSource =
  | { source: "options.shared"; sound: "present" | "none" }
  | { source: "options.seeded-from"; pack: string }
  | { source: "options.sound-filled"; pack: string; filled: number }
  | { source: "options.instance-own" }
  | { source: "options.fresh-yosbr" };

/** The name written to `game-launch.jsonl`, e.g. `options.seeded-from:cobblemon-official`. */
export function optionsSourceLabel(result: OptionsSource): string {
  return result.source === "options.seeded-from" || result.source === "options.sound-filled" ? `${result.source}:${result.pack}` : result.source;
}

/** A real options file: it has at least one `name:value` line. An empty or half-written file is not. */
export function isUsableOptions(text: string): boolean {
  return OPTION_LINE.test(text);
}

/** `soundCategory_*` name → value, from an options.txt; non-numeric values are ignored. */
export function parseSoundLines(text: string): Map<string, string> {
  const sounds = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = SOUND_LINE.exec(line);
    if (match && SOUND_VALUE.test(match[2].trim())) sounds.set(match[1], match[2].trim());
  }
  return sounds;
}

/** `text` with the given sound lines appended in its own line ending; existing lines are never changed. */
export function addSoundLines(text: string, lines: ReadonlyMap<string, string>): string {
  if (lines.size === 0) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text === "" || /\r?\n$/.test(text) ? text : `${text}${eol}`;
  return `${body}${[...lines].map(([name, value]) => `soundCategory_${name}:${value}${eol}`).join("")}`;
}

interface Candidate {
  pack: string;
  file: string;
  mtimeMs: number;
  text: string;
}

/** The other servers' options.txt files, newest first. The instance being started and hidden folders are not among them. */
async function otherInstanceOptions(instanceRoot: string, instanceDir: string): Promise<Candidate[]> {
  let entries;
  try {
    entries = await fsp.readdir(instanceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const own = path.resolve(instanceDir);
  const found: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (path.resolve(instanceRoot, entry.name) === own) continue;
    const file = path.join(instanceRoot, entry.name, "options.txt");
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) continue;
    // latin1 keeps every byte as it was, so a copy is byte for byte what the other server had.
    const text = await fsp.readFile(file, "latin1").catch(() => "");
    if (isUsableOptions(text)) found.push({ pack: entry.name, file, mtimeMs: stat.mtimeMs, text });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const part = `${file}.bweeep-part`;
  await fsp.writeFile(part, data, "latin1");
  await fsp.rename(part, file);
}

/**
 * Makes the shared options.txt carry the player's settings before it is restored
 * into `instanceDir`. Reads other servers' files, writes only the shared copy.
 */
export async function prepareSharedOptions(instanceRoot: string, instanceDir: string, settingsDir: string): Promise<OptionsSource> {
  const sharedFile = path.join(settingsDir, "options.txt");
  const sharedText = await fsp.readFile(sharedFile, "latin1").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (sharedText !== null && isUsableOptions(sharedText)) {
    if (parseSoundLines(sharedText).size > 0) return { source: "options.shared", sound: "present" };
    // The shared file has no volume lines at all: bring in the player's volumes from the newest server that has them.
    for (const other of await otherInstanceOptions(instanceRoot, instanceDir)) {
      const sounds = parseSoundLines(other.text);
      if (sounds.size === 0) continue;
      await writeAtomic(sharedFile, addSoundLines(sharedText, sounds));
      return { source: "options.sound-filled", pack: other.pack, filled: sounds.size };
    }
    return { source: "options.shared", sound: "none" };
  }

  // No usable shared file: start from the newest of the player's other servers.
  const [newest] = await otherInstanceOptions(instanceRoot, instanceDir);
  if (newest) {
    await fsp.mkdir(settingsDir, { recursive: true });
    await writeAtomic(sharedFile, newest.text);
    await fsp.utimes(sharedFile, new Date(), new Date(newest.mtimeMs)).catch(() => undefined);
    return { source: "options.seeded-from", pack: newest.pack };
  }
  // Nothing to inherit: the game's own file stays if it has one, otherwise YOSBR / the game start fresh.
  const own = await fsp.stat(path.join(instanceDir, "options.txt")).catch(() => null);
  return own?.isFile() && own.size > 0 ? { source: "options.instance-own" } : { source: "options.fresh-yosbr" };
}

/** An unusable shared options.txt (empty, half written) must not wipe the instance's own file. */
export async function sharedOptionsUsable(settingsDir: string): Promise<boolean> {
  const text = await fsp.readFile(path.join(settingsDir, "options.txt"), "latin1").catch(() => null);
  return text !== null && isUsableOptions(text);
}

export interface SharedOptionsSync {
  /** Starts the periodic copy; does nothing once stopped. */
  start(): void;
  /** Stops the copy for good, also when the game already ended before `start`. */
  stop(): void;
  /** How many times a changed options.txt was copied (for tests and logs). */
  readonly captures: number;
}

/**
 * Copies the running game's options.txt into the shared store while the game
 * runs, not only when it closes, so a crash, a killed game or a launcher closed
 * first does not lose what the player changed. A tick is one stat call; the
 * file is copied only when its modification time moved, and not while the game
 * is in the middle of writing it.
 */
export function createSharedOptionsSync(
  instanceDir: string,
  capture: () => Promise<void>,
  options: { intervalMs?: number } = {}
): SharedOptionsSync {
  const optionsFile = path.join(instanceDir, "options.txt");
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let busy = false;
  let lastSeen = -1;
  let captures = 0;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const before = await fsp.stat(optionsFile).catch(() => null);
      if (!before?.isFile() || before.size === 0 || before.mtimeMs === lastSeen) return;
      const text = await fsp.readFile(optionsFile, "latin1");
      const after = await fsp.stat(optionsFile).catch(() => null);
      // Changed while it was read: the game is still writing; the next tick picks it up.
      if (!after || after.mtimeMs !== before.mtimeMs || after.size !== before.size || !isUsableOptions(text)) return;
      await capture();
      lastSeen = before.mtimeMs;
      captures += 1;
    } catch {
      // The copy is a safety net; a failed one is retried on the next tick and never reaches the player.
    } finally {
      busy = false;
    }
  };

  return {
    start() {
      if (stopped || timer) return;
      // What the launcher just restored is already shared; only later changes are copied.
      void fsp.stat(optionsFile).then((stat) => { if (lastSeen < 0) lastSeen = stat.mtimeMs; }, () => undefined).finally(() => {
        if (stopped || timer) return;
        timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
        timer.unref();
      });
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    get captures() {
      return captures;
    }
  };
}
