import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import type { LauncherUser, LoginResult } from "../shared/types.js";

interface DiscordConfig {
  clientId?: string;
  redirectUri?: string;
}

const defaultRedirectUri = "http://127.0.0.1:46883/discord/callback";

export async function loginWithDiscord(parent: BrowserWindow): Promise<LoginResult> {
  const config = await readDiscordConfig();
  if (!config.clientId) {
    return {
      configured: false,
      message:
        "Discord client ID가 아직 없습니다. resources/discord.local.json에 clientId를 넣고 Discord Developer Portal에 redirect URI를 등록하세요."
    };
  }

  const redirectUri = config.redirectUri ?? defaultRedirectUri;
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("scope", "identify");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "consent");

  const token = await captureImplicitToken(parent, authUrl.toString(), redirectUri, state);
  const user = await fetchDiscordUser(token);
  return { configured: true, user };
}

async function readDiscordConfig(): Promise<DiscordConfig> {
  if (process.env.BWEEEP_DISCORD_CLIENT_ID) {
    return {
      clientId: process.env.BWEEEP_DISCORD_CLIENT_ID,
      redirectUri: process.env.BWEEEP_DISCORD_REDIRECT_URI ?? defaultRedirectUri
    };
  }

  const configPath = path.join(process.cwd(), "resources", "discord.local.json");
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    return JSON.parse(raw) as DiscordConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function captureImplicitToken(
  parent: BrowserWindow,
  authUrl: string,
  redirectUri: string,
  expectedState: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent,
      modal: true,
      title: "Discord 로그인",
      backgroundColor: "#101214",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const cleanup = () => {
      authWindow.webContents.removeAllListeners("will-navigate");
      authWindow.webContents.removeAllListeners("did-navigate");
      authWindow.webContents.removeAllListeners("did-redirect-navigation");
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
    };

    const inspectUrl = (nextUrl: string) => {
      if (!nextUrl.startsWith(redirectUri)) return;
      const parsed = new URL(nextUrl);
      const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
      const returnedState = fragment.get("state");
      const token = fragment.get("access_token");
      if (returnedState !== expectedState) {
        cleanup();
        reject(new Error("Discord 로그인 state 검증에 실패했습니다."));
        return;
      }
      if (!token) {
        cleanup();
        reject(new Error("Discord access token을 받지 못했습니다."));
        return;
      }
      cleanup();
      resolve(token);
    };

    authWindow.webContents.on("will-navigate", (_event, nextUrl) => inspectUrl(nextUrl));
    authWindow.webContents.on("did-navigate", (_event, nextUrl) => inspectUrl(nextUrl));
    authWindow.webContents.on("did-redirect-navigation", (_event, nextUrl) => inspectUrl(nextUrl));
    authWindow.on("closed", () => reject(new Error("Discord 로그인이 취소되었습니다.")));

    void authWindow.loadURL(authUrl);
  });
}

async function fetchDiscordUser(accessToken: string): Promise<LauncherUser> {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Discord 프로필 조회 실패: ${response.status}`);
  }
  const user = (await response.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name,
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : null,
    provider: "discord"
  };
}
