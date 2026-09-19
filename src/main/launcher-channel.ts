import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export type LauncherChannel = "production" | "test";

export function getLauncherChannel(): LauncherChannel {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as { bweeepChannel?: unknown };
    return packageJson.bweeepChannel === "test" ? "test" : "production";
  } catch {
    return "production";
  }
}

export function launcherProtocolScheme(): string {
  return getLauncherChannel() === "test" ? "bwe-e-ep-test" : "bwe-e-ep";
}

export function launcherWindowTitle(): string {
  return getLauncherChannel() === "test" ? "붸에엡 테스트" : "붸에엡";
}

export function defaultInstanceRoot(): string {
  if (getLauncherChannel() === "test") return path.join(app.getPath("userData"), "instances");
  return path.join(app.getPath("appData"), "Bweeep", "instances");
}
