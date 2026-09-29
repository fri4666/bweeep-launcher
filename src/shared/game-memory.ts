import type { ModpackManifest } from "./types.js";

/** Smallest heap the launcher gives Minecraft; also its starting heap (-Xms). */
export const MIN_GAME_MEMORY_MB = 2048;
/** Left to Windows and other programs when the launcher picks the heap itself. */
const AUTO_RESERVE_MB = 4096;
/** Left over when the player picks the heap by hand. */
const MANUAL_RESERVE_MB = 2048;
const MAX_GAME_MEMORY_MB = 16384;

export interface GameMemory {
  minMb: number;
  maxMb: number;
  /** False when the player chose maxMb in settings. */
  auto: boolean;
}

/** Every pack got 6GB before packs could say what they need. */
const DEFAULT_RECOMMENDED_MB = 6144;

/**
 * The pack's own recommendation, or the old 6GB. There is no estimate from the
 * mod count: the server list leaves out file lists, so the settings screen and
 * the launch would disagree.
 */
export function recommendedMemoryMb(manifest: Pick<ModpackManifest, "recommendedMemoryMb">): number {
  return isMemoryMb(manifest.recommendedMemoryMb) ? manifest.recommendedMemoryMb : DEFAULT_RECOMMENDED_MB;
}

export function isMemoryMb(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1024 && (value as number) <= 65536;
}

/** The recommendation, capped so the rest of the PC keeps 4GB. */
export function autoMemoryMb(recommendedMb: number, totalMb: number): number {
  return Math.max(MIN_GAME_MEMORY_MB, floorTo(Math.min(recommendedMb, totalMb - AUTO_RESERVE_MB), 256));
}

/** Whole-GB steps the settings slider offers on a PC with this much memory. */
export function memoryChoicesMb(totalMb: number): number[] {
  const top = Math.min(MAX_GAME_MEMORY_MB, Math.max(MIN_GAME_MEMORY_MB, floorTo(totalMb - MANUAL_RESERVE_MB, 1024)));
  const choices: number[] = [];
  for (let mb = MIN_GAME_MEMORY_MB; mb <= top; mb += 1024) choices.push(mb);
  return choices;
}

/**
 * Heap for one launch. A chosen value outside what this PC offers (another
 * PC's setting, or a tampered one) snaps to the nearest step.
 */
export function resolveGameMemory(options: { recommendedMb: number; totalMb: number; requestedMb?: number | null }): GameMemory {
  const { recommendedMb, totalMb, requestedMb } = options;
  let maxMb = autoMemoryMb(recommendedMb, totalMb);
  let auto = true;
  if (typeof requestedMb === "number" && Number.isFinite(requestedMb)) {
    const choices = memoryChoicesMb(totalMb);
    maxMb = choices.reduce((best, mb) => Math.abs(mb - requestedMb) < Math.abs(best - requestedMb) ? mb : best, choices[0]);
    auto = false;
  }
  return { minMb: Math.min(MIN_GAME_MEMORY_MB, maxMb), maxMb, auto };
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}
