import { crypto as stdCrypto } from "@std/crypto";

// Mirrors the launcher's createOfflineLaunchIdentity and toLauncherUser, so a
// player keeps the name (and the offline UUID derived from it) they already
// used on offline servers.

export async function launchGameName(
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> },
  savedGameName: string | null
): Promise<string> {
  const metadata = user.user_metadata ?? {};
  const username = firstNonEmptyString(metadata.user_name, metadata.preferred_username, metadata.name, user.email) ?? "Discord 사용자";
  const globalName = firstNonEmptyString(
    metadata.full_name,
    metadata.name,
    [metadata.given_name, metadata.family_name].filter((value): value is string => typeof value === "string").join(" ")
  );
  const readable = [savedGameName, globalName, username]
    .map((candidate) => candidate?.normalize("NFKD").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) ?? "")
    .find((candidate) => candidate.length >= 2);
  if (readable) return readable;
  const digest = new Uint8Array(await stdCrypto.subtle.digest("MD5", new TextEncoder().encode(`OfflinePlayer:${user.id}`)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Bweep_${hex.slice(0, 10)}`;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
