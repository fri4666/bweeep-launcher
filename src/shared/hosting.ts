export type HostingNode = "vps" | "pc";
export interface HostingPolicy {
  primaryNode: HostingNode;
  automatic: boolean;
  failureSeconds: number;
  syncMinutes: number;
  maxSnapshotMinutes: number;
  allowRecovery: boolean;
}
export interface HostingState {
  policy: HostingPolicy;
  revision: number;
  activeNode: HostingNode;
  epoch: number;
  leaseUntil: string;
  requestedNode: HostingNode | null;
  nodes: Array<{ node: HostingNode; lastSeen: string | null; status: string; snapshotAt: string | null; snapshotSource: HostingNode | null; snapshotEpoch: number | null; snapshotId: string | null }>;
}
