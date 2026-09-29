import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { InstallMoveCheck } from "../shared/types.js";
import { moveInstall, planInstallMove, type InstallMoveResult } from "./install-move.js";
import { writeGameLog } from "./logs.js";

// Settings asks "move or download again" when the install location changes.
// A move runs here; the renderer saves the new location, and only then are
// the originals removed, through the id this hands back.

let moving = false;
const finished = new Map<string, InstallMoveResult>();

/** Launching waits while files are moving. */
export function installMoveInProgress(): boolean {
  return moving;
}

export function registerInstallMove(gameBusy: () => boolean): void {
  ipcMain.handle("install:checkMove", async (_event, from: unknown, to: unknown): Promise<InstallMoveCheck> => {
    const plan = await planInstallMove(requirePath(from), requirePath(to));
    return { entries: plan.entries.length, bytes: plan.bytes, ...(plan.problem ? { problem: plan.problem } : {}) };
  });
  ipcMain.handle("install:move", async (event, from: unknown, to: unknown): Promise<string> => {
    if (gameBusy()) throw new Error("게임이 켜져 있거나 설치 중이라 옮길 수 없어요");
    if (moving) throw new Error("이미 옮기는 중이에요");
    moving = true;
    try {
      const plan = await planInstallMove(requirePath(from), requirePath(to));
      if (plan.problem) throw new Error(plan.problem);
      const result = await moveInstall(plan, (percent) => {
        if (!event.sender.isDestroyed()) event.sender.send("install:moveProgress", percent);
      });
      await writeGameLog("install.move.succeeded", { entries: plan.entries.length, bytes: plan.bytes, sameVolume: plan.sameVolume });
      const moveId = randomUUID();
      finished.set(moveId, result);
      return moveId;
    } catch (error) {
      await writeGameLog("install.move.failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      moving = false;
    }
  });
  ipcMain.handle("install:finishMove", async (_event, moveId: unknown) => {
    const result = typeof moveId === "string" ? finished.get(moveId) : undefined;
    if (!result) return;
    finished.delete(moveId as string);
    try {
      await result.removeOriginals();
    } catch (error) {
      // Everything is already in the new location; only leftovers stay behind.
      await writeGameLog("install.move.cleanup-failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

function requirePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("설치 위치가 올바르지 않습니다.");
  return value;
}
