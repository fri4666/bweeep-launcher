import fsp from "node:fs/promises";
import path from "node:path";
import { authOutageMessages, classifyAuthOutage } from "../shared/auth-outage.js";
import type { AccessStatus, AuthOutage, LauncherUser, ModpackManifest } from "../shared/types.js";
import { checkServer } from "./server-status.js";

/** launcher-access (or Supabase auth) did not answer, or answered with a gateway error. */
export class AuthServiceUnavailableError extends Error {
  constructor(readonly status: number, message = "인증 서버에 연결하지 못했어요.") {
    super(message);
    this.name = "AuthServiceUnavailableError";
  }
}

interface Snapshot {
  schemaVersion: 1;
  user: LauncherUser;
  access?: { allowed: boolean; isAdmin: boolean; testAllowed: boolean };
  manifests?: ModpackManifest[];
  savedAt: string;
}

export interface OfflineAccessDeps {
  /** The user id in the saved login session, read without the network. */
  savedUserId: () => Promise<string | null>;
  /** Game servers from the last server list; one that answers means this PC is online. */
  gameServers: () => Array<{ host: string; port: number }>;
  systemOnline: () => boolean;
}

/**
 * The last server list and access seen for the signed-in player, kept in
 * userData so the launcher still opens with its servers while launcher-access
 * is down. Joining a server still needs the auth server, so launches are
 * refused with a one-line reason instead.
 */
export class OfflineAccess {
  constructor(private readonly file: string, private readonly deps: OfflineAccessDeps) {}

  /** The saved session's user when Supabase cannot confirm it right now. */
  async restoreUser(restore: () => Promise<LauncherUser | null>): Promise<LauncherUser | null> {
    try {
      return await restore();
    } catch (error) {
      if (!(error instanceof AuthServiceUnavailableError)) throw error;
      const [snapshot, savedUserId] = await Promise.all([this.read(), this.deps.savedUserId().catch(() => null)]);
      return snapshot && savedUserId === snapshot.user.id ? snapshot.user : null;
    }
  }

  async listManifests(user: LauncherUser, live: () => Promise<ModpackManifest[]>): Promise<ModpackManifest[]> {
    try {
      const manifests = await live();
      await this.update(user, (snapshot) => ({ ...snapshot, manifests }));
      return manifests;
    } catch (error) {
      if (!(error instanceof AuthServiceUnavailableError)) throw error;
      const snapshot = await this.read();
      if (snapshot?.user.id !== user.id || !snapshot.manifests?.length) throw error;
      return snapshot.manifests;
    }
  }

  async rememberAccess(status: AccessStatus): Promise<void> {
    if (!status.loggedIn || !status.user) return;
    const access = { allowed: status.allowed, isAdmin: status.isAdmin, testAllowed: status.testAllowed === true };
    await this.update(status.user, (snapshot) => ({ ...snapshot, user: status.user!, access }));
  }

  /** The last access seen for this user, marked with the outage; null when there is none. */
  async accessDuringOutage(user: LauncherUser, error: unknown): Promise<AccessStatus | null> {
    if (!(error instanceof AuthServiceUnavailableError)) return null;
    const snapshot = await this.read();
    if (snapshot?.user.id !== user.id || !snapshot.access) return null;
    const outage = await this.describe(error);
    return { loggedIn: true, ...snapshot.access, reason: authOutageMessages[outage], user: { ...user, gameName: user.gameName ?? snapshot.user.gameName }, outage };
  }

  /** A launch that failed because launcher-access is down fails with the one-line reason. */
  async launchError(error: unknown): Promise<unknown> {
    return error instanceof AuthServiceUnavailableError ? new Error(authOutageMessages[await this.describe(error)]) : error;
  }

  async clear(): Promise<void> {
    await fsp.rm(this.file, { force: true });
  }

  async describe(error: AuthServiceUnavailableError): Promise<AuthOutage> {
    const systemOnline = this.deps.systemOnline();
    const servers = error.status === 0 && systemOnline ? this.deps.gameServers() : [];
    const statuses = await Promise.all(servers.map((server) => checkServer(server, { timeoutMs: 2500 })));
    return classifyAuthOutage({ status: error.status, systemOnline, gameServerReachable: statuses.some((status) => status.online) });
  }

  private async update(user: LauncherUser, change: (snapshot: Snapshot) => Snapshot): Promise<void> {
    const current = await this.read();
    // Another account's list is never kept next to this one.
    const base: Snapshot = current?.user.id === user.id ? current : { schemaVersion: 1, user, savedAt: "" };
    const next = { ...change({ ...base, user }), savedAt: new Date().toISOString() };
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, this.file);
    } catch {
      // Only a fallback; the live data was already returned.
    }
  }

  private async read(): Promise<Snapshot | null> {
    try {
      const value = JSON.parse(await fsp.readFile(this.file, "utf8")) as Partial<Snapshot> | null;
      if (value?.schemaVersion !== 1 || typeof value.user?.id !== "string") return null;
      if (value.manifests !== undefined && !Array.isArray(value.manifests)) return null;
      return value as Snapshot;
    } catch {
      return null;
    }
  }
}
