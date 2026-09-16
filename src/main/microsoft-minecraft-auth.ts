import type { LaunchIdentity } from "./minecraft-runtime.js";
import { fetchWithSystemNetwork } from "./system-network.js";

interface XboxAuthentication {
  Token?: string;
  DisplayClaims?: { xui?: Array<{ uhs?: string }> };
}

interface MinecraftAuthentication {
  access_token?: string;
}

interface MinecraftEntitlements {
  items?: unknown[];
}

interface MinecraftProfile {
  id?: string;
  name?: string;
}

export async function createMicrosoftLaunchIdentity(microsoftAccessToken: string): Promise<LaunchIdentity> {
  const xbox = await request<XboxAuthentication>("https://user.auth.xboxlive.com/user/authenticate", {
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: `d=${microsoftAccessToken}`
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT"
  });
  const xboxToken = requiredString(xbox.Token, "Xbox 인증 토큰");
  const userHash = requiredString(xbox.DisplayClaims?.xui?.[0]?.uhs, "Xbox 사용자 정보");

  const xsts = await request<XboxAuthentication>("https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: {
      SandboxId: "RETAIL",
      UserTokens: [xboxToken]
    },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT"
  });
  const xstsToken = requiredString(xsts.Token, "XSTS 인증 토큰");

  const minecraft = await request<MinecraftAuthentication>("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`
  });
  const accessToken = requiredString(minecraft.access_token, "Minecraft 인증 토큰");
  const headers = { Authorization: `Bearer ${accessToken}` };
  const entitlements = await get<MinecraftEntitlements>("https://api.minecraftservices.com/entitlements/mcstore", headers);
  if (!Array.isArray(entitlements.items) || entitlements.items.length === 0) {
    throw new Error("이 Microsoft 계정에는 Minecraft: Java Edition 이용 권한이 없습니다.");
  }
  const profile = await get<MinecraftProfile>("https://api.minecraftservices.com/minecraft/profile", headers);
  const id = requiredString(profile.id, "Minecraft 프로필 ID");
  const name = requiredString(profile.name, "Minecraft 닉네임");
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name) || !/^[a-f0-9]{32}$/i.test(id)) {
    throw new Error("Minecraft 프로필 형식이 올바르지 않습니다.");
  }
  return { id, name, accessToken, userType: "msa" };
}

async function request<T>(url: string, body: unknown): Promise<T> {
  const response = await fetchWithSystemNetwork(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("Microsoft/Xbox 인증을 완료하지 못했습니다.");
  return response.json() as Promise<T>;
}

async function get<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetchWithSystemNetwork(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Minecraft 계정 정보를 확인하지 못했습니다.");
  return response.json() as Promise<T>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}을 받지 못했습니다.`);
  return value;
}
