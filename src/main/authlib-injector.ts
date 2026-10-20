import path from "node:path";
import { ensureVerifiedCopy } from "./verified-copy.js";

/**
 * authlib-injector redirects Minecraft's login and skin requests to the
 * Bweeep Yggdrasil API. It is a Java agent, so it works the same for every
 * Minecraft version and loader. Shipped unmodified under its AGPL exception
 * (resources/authlib-injector/LICENSE.txt).
 */
const AGENT = {
  fileName: "authlib-injector-1.2.8.jar",
  sha256: "9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10"
};

export interface YggdrasilLaunch {
  /** Root of the Bweeep Yggdrasil API. */
  apiRoot: string;
  /** API metadata JSON, passed to the agent so it need not fetch it again. */
  metadata: string;
}

export function yggdrasilApiRoot(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/yggdrasil`;
}

/** Java cannot load an agent from inside app.asar, so a verified copy is kept per instance. */
export function ensureAuthlibInjector(resourcesRoot: string, instanceDir: string): Promise<string> {
  return ensureVerifiedCopy(
    path.join(resourcesRoot, AGENT.fileName),
    AGENT.sha256,
    path.join(instanceDir, ".bweeep", "authlib-injector.jar"),
    "로그인 연결 파일(authlib-injector)이 손상되었습니다."
  );
}

export function authlibInjectorJvmArgs(agentPath: string, launch: YggdrasilLaunch): string[] {
  return [
    `-javaagent:${agentPath}=${launch.apiRoot}`,
    `-Dauthlibinjector.yggdrasil.prefetched=${Buffer.from(launch.metadata, "utf8").toString("base64")}`
  ];
}

/** Rejects anything that is not API metadata, so a bad response fails before Minecraft starts. */
export function parseYggdrasilMetadata(text: string): string {
  const value: unknown = JSON.parse(text);
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof record.signaturePublickey !== "string" || !record.signaturePublickey.includes("BEGIN PUBLIC KEY") || !Array.isArray(record.skinDomains)) {
    throw new Error("로그인 서버 정보 형식이 올바르지 않습니다.");
  }
  return JSON.stringify(value);
}
