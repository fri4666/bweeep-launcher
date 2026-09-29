import { app, ipcMain } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DiscordPresenceSetting } from "../shared/types.js";
import { DISCORD_CLIENT_ID, DiscordPresence } from "./discord-presence.js";

// The launcher's side of the Discord status: the on/off setting (on by
// default, kept in the app data folder) and the game start and end hooks.

const presence = new DiscordPresence();
let enabled = true;

function settingsFile(): string {
  return path.join(app.getPath("userData"), "discord-presence.json");
}

function setting(): DiscordPresenceSetting {
  return { available: Boolean(DISCORD_CLIENT_ID), enabled };
}

async function loadSetting(): Promise<void> {
  try {
    const saved = JSON.parse(await fsp.readFile(settingsFile(), "utf8")) as { enabled?: unknown };
    if (typeof saved.enabled === "boolean") enabled = saved.enabled;
  } catch {
    // No saved choice yet: on.
  }
  presence.setEnabled(enabled);
}

export function registerDiscordPresence(): void {
  const loaded = loadSetting();
  ipcMain.handle("discord:presence", async () => {
    await loaded;
    return setting();
  });
  ipcMain.handle("discord:setPresence", async (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new Error("설정 값이 올바르지 않습니다.");
    await loaded;
    enabled = value;
    presence.setEnabled(value);
    await fsp.writeFile(settingsFile(), JSON.stringify({ enabled: value }), "utf8");
    return setting();
  });
  app.on("before-quit", () => presence.dispose());
}

export function discordGameStarted(serverName: string, startedAt: number): void {
  presence.gameStarted(serverName, startedAt);
}

export function discordGameStopped(): void {
  presence.gameStopped();
}
