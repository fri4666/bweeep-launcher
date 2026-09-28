// Wire format of the Yggdrasil API that authlib-injector expects, following
// https://yushijinhun.github.io/authlib-injector/en/yggdrasil-server-technical-specification.html

export type SkinModel = "default" | "slim";

export interface ProfileRow {
  minecraft_uuid: string;
  game_name: string;
  texture_hash: string | null;
  model: SkinModel | null;
}

interface ProfileProperty {
  name: string;
  value: string;
  signature?: string;
}

export interface SerializedProfile {
  id: string;
  name: string;
  properties?: ProfileProperty[];
}

export type Route =
  | { kind: "metadata" }
  | { kind: "join" }
  | { kind: "hasJoined" }
  | { kind: "profile"; id: string }
  | { kind: "profilesByName" }
  | { kind: "profileByName"; name: string }
  | { kind: "notFound" };

/** Maximum names in one batch lookup; the specification requires at least 2. */
export const MAX_BATCH_NAMES = 10;
export const SKIN_BUCKET = "launcher-skins";

const gameNamePattern = /^[A-Za-z0-9_]{2,16}$/;
const unsignedUuidPattern = /^[0-9a-f]{32}$/i;

export function isGameName(value: unknown): value is string {
  return typeof value === "string" && gameNamePattern.test(value);
}

export function isUnsignedUuid(value: unknown): value is string {
  return typeof value === "string" && unsignedUuidPattern.test(value);
}

export function toUnsignedUuid(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

export function toSignedUuid(unsigned: string): string {
  const hex = unsigned.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The function is served below /yggdrasil; everything after it is the API path. */
export function parseRoute(method: string, pathname: string): Route {
  const segments = pathname.split("/").filter(Boolean);
  const base = segments.indexOf("yggdrasil");
  const path = (base >= 0 ? segments.slice(base + 1) : segments).join("/");
  if (method === "GET" && path === "") return { kind: "metadata" };
  if (method === "POST" && path === "sessionserver/session/minecraft/join") return { kind: "join" };
  if (method === "GET" && path === "sessionserver/session/minecraft/hasJoined") return { kind: "hasJoined" };
  const profile = /^sessionserver\/session\/minecraft\/profile\/([^/]+)$/.exec(path);
  if (method === "GET" && profile) return { kind: "profile", id: profile[1] };
  if (method === "POST" && path === "api/profiles/minecraft") return { kind: "profilesByName" };
  const byName = /^api\/users\/profiles\/minecraft\/([^/]+)$/.exec(path);
  if (method === "GET" && byName) return { kind: "profileByName", name: decodeURIComponent(byName[1]) };
  return { kind: "notFound" };
}

export function apiMetadata(publicKeyPem: string, publicUrl: string) {
  return {
    meta: {
      serverName: "Bweeep",
      implementationName: "bweeep-yggdrasil",
      implementationVersion: "1",
      "feature.non_email_login": true,
      // Names are looked up here only; never fall back to Mojang profiles.
      "feature.no_mojang_namespace": true
    },
    skinDomains: [new URL(publicUrl).hostname],
    signaturePublickey: publicKeyPem
  };
}

export function skinUrl(publicUrl: string, textureHash: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/storage/v1/object/public/${SKIN_BUCKET}/${textureHash}.png`;
}

/** Base64 JSON of the `textures` property. An empty map shows the default skin. */
export function texturesValue(row: ProfileRow, publicUrl: string, timestamp: number): string {
  const profileId = toUnsignedUuid(row.minecraft_uuid);
  const textures = row.texture_hash
    ? {
        SKIN: {
          url: skinUrl(publicUrl, row.texture_hash),
          ...(row.model === "slim" ? { metadata: { model: "slim" } } : {})
        }
      }
    : {};
  const payload = { timestamp, profileId, profileName: row.game_name, textures };
  return encodeBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

export async function serializeProfile(
  row: ProfileRow,
  options: { publicUrl: string; signingKey: CryptoKey | null; withProperties: boolean; timestamp?: number }
): Promise<SerializedProfile> {
  const profile: SerializedProfile = { id: toUnsignedUuid(row.minecraft_uuid), name: row.game_name };
  if (!options.withProperties) return profile;
  const value = texturesValue(row, options.publicUrl, options.timestamp ?? Date.now());
  const property: ProfileProperty = { name: "textures", value };
  if (options.signingKey) property.signature = await sign(options.signingKey, value);
  profile.properties = [property];
  return profile;
}

// Minecraft verifies texture properties with SHA1withRSA against signaturePublickey.
const signingAlgorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" } as const;

export async function sign(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(signingAlgorithm, key, new TextEncoder().encode(value));
  return encodeBase64(new Uint8Array(signature));
}

export async function generateSigningKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { ...signingAlgorithm, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const privateDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: toPem("PRIVATE KEY", privateDer), publicKey: toPem("PUBLIC KEY", publicDer) };
}

export function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromPem(privateKeyPem), signingAlgorithm, false, ["sign"]);
}

export function importVerifyKey(publicKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromPem(publicKeyPem), signingAlgorithm, false, ["verify"]);
}

export function yggdrasilError(status: number, error: string, errorMessage: string): Response {
  return Response.json({ error, errorMessage }, { status });
}

export async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function toPem(label: string, der: Uint8Array): string {
  const body = encodeBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function fromPem(pem: string): Uint8Array<ArrayBuffer> {
  const binary = atob(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
