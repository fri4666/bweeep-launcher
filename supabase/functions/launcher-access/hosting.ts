export interface HostingPolicy {
  primaryNode: "vps" | "pc"; automatic: boolean; failureSeconds: number;
  syncMinutes: number; maxSnapshotMinutes: number; allowRecovery: boolean;
}
export function parseHostingPolicy(value: unknown): HostingPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "allowRecovery,automatic,failureSeconds,maxSnapshotMinutes,primaryNode,syncMinutes") return null;
  if ((p.primaryNode !== "vps" && p.primaryNode !== "pc") || typeof p.automatic !== "boolean" || typeof p.allowRecovery !== "boolean") return null;
  if (![p.failureSeconds,p.syncMinutes,p.maxSnapshotMinutes].every(v=>typeof v === "number" && Number.isInteger(v))) return null;
  const failureSeconds=p.failureSeconds as number, syncMinutes=p.syncMinutes as number, maxSnapshotMinutes=p.maxSnapshotMinutes as number;
  if (failureSeconds<90 || failureSeconds>1800 || syncMinutes<1 || syncMinutes>60 || maxSnapshotMinutes<1 || maxSnapshotMinutes>120 || syncMinutes>maxSnapshotMinutes || (p.automatic && !p.allowRecovery)) return null;
  return {primaryNode:p.primaryNode,automatic:p.automatic,allowRecovery:p.allowRecovery,failureSeconds,syncMinutes,maxSnapshotMinutes};
}
