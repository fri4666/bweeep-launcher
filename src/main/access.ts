import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { AccessStatus, CreatedInvite, InviteResult, LauncherUser } from "../shared/types.js";

interface AccessPolicy {
  adminDiscordIds: string[];
  allowedDiscordIds: string[];
}

interface InviteRecord {
  codeHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  redeemedBy?: string;
  redeemedAt?: string;
}

interface AccessState {
  invitedDiscordIds: string[];
  invites: InviteRecord[];
}

const emptyPolicy: AccessPolicy = {
  adminDiscordIds: [],
  allowedDiscordIds: []
};

const emptyState: AccessState = {
  invitedDiscordIds: [],
  invites: []
};

export async function getAccessStatus(user: LauncherUser | null): Promise<AccessStatus> {
  if (!user) {
    return { loggedIn: false, allowed: false, isAdmin: false, reason: "Discord 로그인이 필요합니다." };
  }

  const [policy, state] = await Promise.all([readPolicy(), readState()]);
  const isAdmin = policy.adminDiscordIds.includes(user.id);
  const allowed =
    isAdmin || policy.allowedDiscordIds.includes(user.id) || state.invitedDiscordIds.includes(user.id);

  return {
    loggedIn: true,
    allowed,
    isAdmin,
    reason: allowed ? "런처 사용 권한이 있습니다." : "초대 코드가 필요합니다.",
    user
  };
}

export async function redeemInvite(user: LauncherUser | null, code: string): Promise<InviteResult> {
  if (!user) {
    return {
      ok: false,
      message: "Discord 로그인 후 초대 코드를 사용할 수 있습니다.",
      status: await getAccessStatus(null)
    };
  }

  const normalized = normalizeCode(code);
  const state = await readState();
  const now = new Date();
  const invite = state.invites.find((record) => record.codeHash === hashCode(normalized));

  if (!invite) {
    return { ok: false, message: "초대 코드를 찾지 못했습니다.", status: await getAccessStatus(user) };
  }
  if (invite.redeemedBy && invite.redeemedBy !== user.id) {
    return { ok: false, message: "이미 다른 사용자가 사용한 초대 코드입니다.", status: await getAccessStatus(user) };
  }
  if (new Date(invite.expiresAt) < now) {
    return { ok: false, message: "만료된 초대 코드입니다.", status: await getAccessStatus(user) };
  }

  invite.redeemedBy = user.id;
  invite.redeemedAt = now.toISOString();
  if (!state.invitedDiscordIds.includes(user.id)) {
    state.invitedDiscordIds.push(user.id);
  }
  await writeState(state);

  return { ok: true, message: "초대가 등록되었습니다.", status: await getAccessStatus(user) };
}

export async function createInvite(user: LauncherUser | null): Promise<CreatedInvite> {
  const status = await getAccessStatus(user);
  if (!user || !status.isAdmin) {
    throw new Error("초대 코드는 관리자만 만들 수 있습니다.");
  }

  const state = await readState();
  const code = [
    "BWEEP",
    crypto.randomBytes(3).toString("hex").toUpperCase(),
    crypto.randomBytes(3).toString("hex").toUpperCase()
  ].join("-");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
  state.invites.push({
    codeHash: hashCode(code),
    createdBy: user.id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  });
  await writeState(state);

  return { code, expiresAt: expiresAt.toISOString(), maxUses: 1 };
}

async function readPolicy(): Promise<AccessPolicy> {
  const policyPath = path.join(process.cwd(), "resources", "access-policy.json");
  try {
    const raw = await fsp.readFile(policyPath, "utf8");
    return { ...emptyPolicy, ...(JSON.parse(raw) as AccessPolicy) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPolicy;
    throw error;
  }
}

async function readState(): Promise<AccessState> {
  try {
    const raw = await fsp.readFile(statePath(), "utf8");
    return { ...emptyState, ...(JSON.parse(raw) as AccessState) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState;
    throw error;
  }
}

async function writeState(state: AccessState): Promise<void> {
  await fsp.mkdir(path.dirname(statePath()), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

function statePath(): string {
  return path.join(app.getPath("userData"), "access-state.json");
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeCode(code)).digest("hex");
}
