/**
 * Why the Bweeep account API turned a player away (see migration
 * 20260930100100_record_auth_failures.sql).
 */
export type AuthFailureReason =
  | "unknown_token"
  | "token_revoked"
  | "token_expired"
  | "signed_out"
  | "not_member"
  | "profile_mismatch"
  | "no_join"
  | "name_mismatch"
  | "testers_only"
  | "unknown";

/** The player's own most recent refusal during a game run. */
export interface AuthFailure {
  reason: AuthFailureReason;
  at: string;
}

/** A name held for a day: one a member moved away from, or any name of a member removed less than a day ago. */
export interface NameHold {
  userId: string;
  owner: string;
  gameName: string;
  kind: "released" | "removed";
  heldUntil: string;
}

/** An offline UUID that keeps world data on a server, and who it belongs to (null: nobody). */
export interface UuidReservation {
  minecraftUuid: string;
  gameName: string;
  userId: string | null;
  owner: string | null;
  source: string;
  createdAt: string;
}

export interface AdminNames {
  holds: NameHold[];
  reservations: UuidReservation[];
}

export interface AdminRelease {
  id: string;
  packId: string;
  name: string;
  version: string;
  active: boolean;
  gameAuth: "offline" | "yggdrasil";
  audience: "members" | "testers";
  createdAt: string;
}

export interface AdminAuthFailure {
  id: string;
  userId: string | null;
  owner: string | null;
  gameName: string | null;
  audience: "members" | "testers";
  reason: AuthFailureReason;
  at: string;
}

export interface DiagnosticUpload {
  id: string;
  userId: string;
  owner: string;
  sizeBytes: number;
  at: string;
}

export interface AdminDiagnostics {
  failures: AdminAuthFailure[];
  uploads: DiagnosticUpload[];
}
