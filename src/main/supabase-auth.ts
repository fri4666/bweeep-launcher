import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { app, safeStorage, shell } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AccessStatus, CreatedInvite, LauncherUser, LoginProvider, LoginResult, InviteResult, ModpackManifest } from "../shared/types.js";
import { parseAuthCallback } from "./deep-link.js";
import { createDiscordLaunchIdentity, type LaunchIdentity } from "./minecraft-runtime.js";
import { createMicrosoftLaunchIdentity } from "./microsoft-minecraft-auth.js";

interface SupabaseConfig {
  url?: string;
  publishableKey?: string;
  redirectUri?: string;
}

interface FunctionStatus {
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
}

interface FunctionInviteResult extends FunctionStatus {
  ok: boolean;
  message: string;
}

interface FunctionCreatedInvite {
  code: string;
  expiresAt: string;
}

interface FunctionManifest {
  manifest: ModpackManifest;
  version: string;
}

const defaultRedirectUri = "bwe-e-ep://auth/callback";

export class SupabaseAuth {
  private client: SupabaseClient | null = null;
  private loginInFlight = false;

  async startLogin(provider: LoginProvider): Promise<LoginResult> {
    const client = await this.getClient();
    if (!client) {
      return {
        configured: false,
        message: "Supabase 설정이 필요합니다. resources/supabase.local.json에 URL과 publishableKey를 넣으세요."
      };
    }
    if (this.loginInFlight) {
      return { configured: true, pending: true, message: "브라우저에서 Discord 로그인을 진행하고 있습니다." };
    }

    const supabaseProvider = provider === "microsoft" ? "azure" : "discord";
    this.loginInFlight = true;
    const { data, error } = await client.auth.signInWithOAuth({
      provider: supabaseProvider,
      options: {
        redirectTo: (await readConfig()).redirectUri ?? defaultRedirectUri,
        skipBrowserRedirect: true,
        scopes: provider === "microsoft" ? "email offline_access XboxLive.signin" : undefined
      }
    });
    if (error || !data.url) {
      this.loginInFlight = false;
      throw new Error(error?.message ?? "Discord 로그인 주소를 만들지 못했습니다.");
    }

    try {
      await shell.openExternal(data.url);
      return { configured: true, pending: true, message: `브라우저에서 ${provider === "microsoft" ? "Microsoft" : "Discord"} 로그인을 완료해 주세요.` };
    } catch (error) {
      this.loginInFlight = false;
      throw error;
    }
  }

  async completeCallback(rawUrl: string): Promise<LauncherUser> {
    try {
      const client = await this.requireClient();
      const { code } = parseAuthCallback(rawUrl);
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error || !data.user) {
        throw new Error(error?.message ?? "Discord 세션을 만들지 못했습니다.");
      }
      return toLauncherUser(data.user);
    } finally {
      this.loginInFlight = false;
    }
  }

  async restoreUser(): Promise<LauncherUser | null> {
    const client = await this.getClient();
    if (!client) return null;

    const { data } = await client.auth.getUser();
    return data.user ? toLauncherUser(data.user) : null;
  }

  async getAccessStatus(user: LauncherUser | null): Promise<AccessStatus> {
    if (!user) {
      return { loggedIn: false, allowed: false, isAdmin: false, reason: "Discord 로그인이 필요합니다." };
    }

    const client = await this.getClient();
    if (!client) {
      return { loggedIn: true, allowed: false, isAdmin: false, reason: "Supabase 설정이 필요합니다.", user };
    }

    const { data, error } = await client.functions.invoke<FunctionStatus>("launcher-access", {
      body: { action: "status" }
    });
    if (error || !data) {
      throw new Error(error?.message ?? "접근 권한을 확인하지 못했습니다.");
    }
    return { loggedIn: true, allowed: data.allowed, isAdmin: data.isAdmin, reason: data.reason, user };
  }

  async redeemInvite(user: LauncherUser | null, code: string): Promise<InviteResult> {
    if (!user) {
      return {
        ok: false,
        message: "Discord 로그인 후 초대 코드를 사용할 수 있습니다.",
        status: await this.getAccessStatus(null)
      };
    }

    const client = await this.requireClient();
    const { data, error } = await client.functions.invoke<FunctionInviteResult>("launcher-access", {
      body: { action: "redeem", code }
    });
    if (error || !data) {
      throw new Error(error?.message ?? "초대 코드를 사용할 수 없습니다.");
    }
    return {
      ok: data.ok,
      message: data.message,
      status: { loggedIn: true, allowed: data.allowed, isAdmin: data.isAdmin, reason: data.message, user }
    };
  }

  async createInvite(user: LauncherUser | null): Promise<CreatedInvite> {
    if (!user) throw new Error("Discord 로그인이 필요합니다.");

    const client = await this.requireClient();
    const { data, error } = await client.functions.invoke<FunctionCreatedInvite>("launcher-access", {
      body: { action: "createInvite" }
    });
    if (error || !data) {
      throw new Error(error?.message ?? "초대 코드를 만들지 못했습니다.");
    }
    return { code: data.code, expiresAt: data.expiresAt };
  }

  async signOut(): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) throw new Error(error.message);
    this.client = null;
  }

  async getManifest(user: LauncherUser | null, packId: string): Promise<ModpackManifest> {
    if (!user) throw new Error("Discord 로그인이 필요합니다.");

    const client = await this.requireClient();
    const { data, error } = await client.functions.invoke<FunctionManifest>("launcher-access", {
      body: { action: "manifest", packId }
    });
    if (error || !data?.manifest) {
      throw new Error(error?.message ?? "모드팩 정보를 가져오지 못했습니다.");
    }
    return data.manifest;
  }

  async createLaunchIdentity(user: LauncherUser | null): Promise<LaunchIdentity> {
    if (!user) throw new Error("런처 로그인이 필요합니다.");
    if (user.provider === "discord") {
      return createDiscordLaunchIdentity(user.id, user.globalName ?? user.username);
    }

    const client = await this.requireClient();
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.provider_token) {
      throw new Error("Microsoft 게임 인증이 만료되었습니다. Microsoft로 다시 로그인해 주세요.");
    }
    return createMicrosoftLaunchIdentity(data.session.provider_token);
  }

  private async getClient(): Promise<SupabaseClient | null> {
    if (this.client) return this.client;

    const config = await readConfig();
    if (!config.url || !config.publishableKey) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows 자격 증명 암호화를 사용할 수 없어 로그인 세션을 저장할 수 없습니다.");
    }

    this.client = createClient(config.url, config.publishableKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: new EncryptedSessionStorage()
      }
    });
    return this.client;
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.getClient();
    if (!client) throw new Error("Supabase 설정이 필요합니다.");
    return client;
  }
}

class EncryptedSessionStorage {
  async getItem(key: string): Promise<string | null> {
    const values = await this.read();
    return values[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    const values = await this.read();
    values[key] = value;
    await this.write(values);
  }

  async removeItem(key: string): Promise<void> {
    const values = await this.read();
    delete values[key];
    await this.write(values);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const encrypted = await fsp.readFile(sessionPath(), "utf8");
      const plain = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      return JSON.parse(plain) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("저장된 로그인 세션을 읽을 수 없습니다.");
    }
  }

  private async write(values: Record<string, string>): Promise<void> {
    await fsp.mkdir(path.dirname(sessionPath()), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString("base64");
    await fsp.writeFile(sessionPath(), encrypted, { encoding: "utf8", mode: 0o600 });
  }
}

async function readConfig(): Promise<SupabaseConfig> {
  if (process.env.BWEEEP_SUPABASE_URL && process.env.BWEEEP_SUPABASE_PUBLISHABLE_KEY) {
    return {
      url: process.env.BWEEEP_SUPABASE_URL,
      publishableKey: process.env.BWEEEP_SUPABASE_PUBLISHABLE_KEY,
      redirectUri: process.env.BWEEEP_SUPABASE_REDIRECT_URI ?? defaultRedirectUri
    };
  }

  try {
    const raw = await fsp.readFile(localConfigPath("supabase.local.json"), "utf8");
    return JSON.parse(raw) as SupabaseConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && app.isPackaged) {
      const raw = await fsp.readFile(path.join(app.getAppPath(), "resources", "supabase.example.json"), "utf8");
      return JSON.parse(raw) as SupabaseConfig;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function sessionPath(): string {
  return path.join(app.getPath("userData"), "supabase-auth.json");
}

function localConfigPath(filename: string): string {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), "bweeep-config", filename)
    : path.join(process.cwd(), "resources", filename);
}

function toLauncherUser(user: { id: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): LauncherUser {
  const metadata = user.user_metadata ?? {};
  const provider = user.app_metadata?.provider === "azure" ? "microsoft" : "discord";
  const username = typeof metadata.user_name === "string"
    ? metadata.user_name
    : typeof metadata.preferred_username === "string"
      ? metadata.preferred_username
      : provider === "microsoft" ? "Microsoft 사용자" : "Discord 사용자";
  const globalName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string" ? metadata.name : null;
  const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;
  return { id: user.id, username, globalName, avatarUrl, provider };
}
