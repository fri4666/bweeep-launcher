import crypto from "node:crypto";

export interface LaunchIdentity {
  id: string;
  name: string;
  accessToken: string;
}

export function createOfflineLaunchIdentity(
  accountId: string,
  ...nameCandidates: Array<string | null | undefined>
): LaunchIdentity {
  const digest = crypto.createHash("md5").update(`OfflinePlayer:${accountId}`).digest("hex");
  const readable = nameCandidates
    .map((candidate) => candidate?.normalize("NFKD").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) ?? "")
    .find((candidate) => candidate.length >= 2) ?? "";
  return {
    id: digest,
    name: readable.length >= 2 ? readable : `Bweep_${digest.slice(0, 10)}`,
    accessToken: crypto.randomUUID().replaceAll("-", "")
  };
}
