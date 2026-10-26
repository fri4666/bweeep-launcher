import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessStatus,
  CreatedInvite,
  GameStatus,
  InviteList,
  LauncherUpdateStatus,
  LauncherUser,
  LoaderKind,
  ServerPreset,
  ServerSoftwareKind,
  SkinState,
  SyncProgress,
  UserContentFolders,
  UserContentKind,
  WhatsNew
} from "../shared/types.js";
import "pretendard/dist/web/variable/pretendardvariable.css";
import "./styles.css";
import "./settings.css";
import { AdminPanel } from "./AdminPanel.js";
import { AuthFailureLine, DiagnosticsButton } from "./AuthFailureNotice.js";
import { ModsPanel } from "./ModsPanel.js";
import { InstallMoveDialog } from "./InstallMoveDialog.js";
import { DiscordPresencePanel } from "./DiscordPresencePanel.js";
import { PatchNotesPanel, ReleaseMeta, ReleaseNoteSections, releaseTitle } from "./PatchNotesPanel.js";
import { ServerConnectionBadge, ServerOffIcon, serverState as describeServerState } from "./ServerSwitcher.js";
import { MemoryPanel, savedMemoryMb } from "./MemoryPanel.js";
import { useNotice } from "./useNotice.js";
import { useOfflineLaunchConsent, useServerStatuses } from "./useServerStatuses.js";
import { authOutageFromMessage, authOutageMessages } from "../shared/auth-outage.js";
import { SkinFront } from "./SkinFront.js";
import { SettingsHub, type SettingsSection } from "./SettingsHub.js";
import { closedMessage } from "../shared/open-hours.js";
import type { LauncherNotice } from "../shared/notice.js";

// The 3D skin preview brings in three.js, so it loads when the skin tab first opens.
const SkinPanel = lazy(() => import("./SkinPanel.js").then((module) => ({ default: module.SkinPanel })));

const selectedPackStorageKey = "bweeep.selected-pack-id";
const instanceRootStorageKey = "bweeep.instance-root";
const gameNamePattern = /^[A-Za-z0-9_]{3,16}$/;
const adminInviteSizes = [1, 5, 10, 20];
const launcherIconUrl = new URL("../../build/icon-source-v2.png", import.meta.url).href;

type LogEntry = SyncProgress & { at: number };
type CatalogState = "loading" | "ready" | "error";
/** `outage`: the auth server is down, so there is nowhere to send diagnostics. */
type DockError = { title: string; message: string; retryWithoutPersonalMods?: boolean; crash?: boolean; authFailure?: string; outage?: boolean };
type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage is only a convenience; the launcher still works without it.
  }
}

/** Electron prefixes rejected IPC calls with the channel name; players only need the reason. */
function crashError(status: GameStatus): DockError {
  return {
    title: "게임이 꺼졌어요",
    message: status.retryWithoutPersonalMods
      ? `${status.exitMessage ?? "실행 중 오류"} · 개인 모드 때문일 수 있어요`
      : status.exitMessage ?? "실행 중 오류",
    retryWithoutPersonalMods: Boolean(status.retryWithoutPersonalMods),
    crash: true
  };
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function WindowControls() {
  return (
    <div className="windowControls" aria-label="창 제어">
      <button type="button" aria-label="최소화" onClick={() => window.bweeep.minimizeWindow()}>−</button>
      <button type="button" className="closeWindowButton" aria-label="닫기" onClick={() => window.bweeep.closeWindow()}>×</button>
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function ProfileAvatar({ skin }: { skin: SkinState | null }) {
  const character = skin?.current ?? skin?.defaults[0];
  if (character) {
    return (
      <SkinFront
        dataUrl={character.dataUrl}
        model={character.model}
        className="profileCharacter"
        label={skin?.current ? "적용 중인 Minecraft 캐릭터" : "기본 Minecraft 캐릭터 미리보기"}
      />
    );
  }
  // A local block character keeps the profile visible before a skin is available.
  return (
    <svg className="profileCharacter" viewBox="0 0 16 32" role="img" aria-label="기본 캐릭터 미리보기" shapeRendering="crispEdges">
      <path fill="#b5c8e4" d="M4 8h8v12H4zM0 8h4v12H0zM12 8h4v12h-4z" />
      <path fill="#8dabc9" d="M4 8h2v12H4zM12 8h2v12h-2z" />
      <path fill="#e1bda1" d="M4 0h8v8H4zM0 18h4v2H0zM12 18h4v2h-4z" />
      <path fill="#344156" d="M4 0h8v2H4zM4 2h2v2H4zM11 2h1v2h-1zM4 20h8v12H4z" />
      <path fill="#172237" d="M7 21h2v11H7zM4 30h8v2H4zM6 4h1v1H6zM9 4h1v1H9z" />
      <path fill="#b58270" d="M7 6h2v1H7z" />
    </svg>
  );
}

function SettingsIcon({ kind }: { kind: string }) {
  const paths: Record<string, ReactNode> = {
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" /></>,
    skin: <path d="m8 4-5 4 3 4 2-1v9h8v-9l2 1 3-4-5-4c-1 3-7 3-8 0Z" />,
    game: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 21h8M12 16v5" /></>,
    mods: <><path d="M7 7h10c2 0 3 2 3.5 5l1 5c.4 2-1.5 3-3 1l-3-3h-7l-3 3c-1.5 2-3.4 1-3-1l1-5C4 9 5 7 7 7Z" /><path d="M8 10v4M6 12h4M16 11h.01M18 13h.01" /></>,
    community: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></>,
    patch: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    admin: <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6zM9 12l2 2 4-4" /></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}

function EntryLayout({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <main className="entryScreen">
      <WindowControls />
      <div className="entryVisual" aria-hidden="true">
        <span className="entryWordmark"><img className="launcherMark" src={launcherIconUrl} alt="" /></span>
        <div><p>MINECRAFT JAVA EDITION</p><strong>함께하는 세계,<br />다음 이야기를 시작하세요.</strong></div>
      </div>
      <section className="entryCard">
        <span className="entryBrand"><img className="launcherMark" src={launcherIconUrl} alt="붸에엡 런처" /></span>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="modalBackdrop confirmBackdrop" onClick={onClose}>
      <section className="confirmDialog" role="alertdialog" aria-modal="true" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
        <h2>{request.title}</h2>
        <p>{request.body}</p>
        <div className="confirmActions">
          <button ref={cancelRef} className="secondaryButton" onClick={onClose}>취소</button>
          <button
            className={request.danger ? "dangerButton" : "primaryButton"}
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Shown once on the first start after an update, from the release notes. */
function WhatsNewDialog({ whatsNew, onClose }: { whatsNew: WhatsNew; onClose: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div className="modalBackdrop confirmBackdrop" onClick={onClose}>
      <section className="confirmDialog whatsNewDialog" role="dialog" aria-modal="true" aria-label="업데이트 소식" onClick={(event) => event.stopPropagation()}>
        <h2 className="releaseTitle">{releaseTitle(whatsNew.version)}</h2>
        <ReleaseMeta />
        {whatsNew.summary && <p className="releaseSummary">요약: {whatsNew.summary}</p>}
        <ReleaseNoteSections sections={whatsNew.sections} />
        <div className="confirmActions">
          <button ref={confirmRef} className="primaryButton" onClick={onClose}>확인</button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [servers, setServers] = useState<ServerPreset[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [instanceRoot, setInstanceRoot] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [dockError, setDockError] = useState<DockError | null>(null);
  const [joinedServer, setJoinedServer] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [entryError, setEntryError] = useState("");
  const [accessChecking, setAccessChecking] = useState(false);
  const [user, setUser] = useState<LauncherUser | null>(null);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteList, setInviteList] = useState<InviteList | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [actionToast, setActionToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileSkin, setProfileSkin] = useState<{ owner: string; root: string; state: SkinState } | null>(null);
  const skinRevision = useRef(0);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);
  const [launcherChannel, setLauncherChannel] = useState<"production" | "test">("production");
  const [launcherVersion, setLauncherVersion] = useState("");
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null);
  const [gameStatus, setGameStatus] = useState<GameStatus>({ state: "idle" });
  const [gameNameInput, setGameNameInput] = useState("");
  const [personalFolders, setPersonalFolders] = useState<UserContentFolders>({ mods: [], shaderpacks: [] });
  const [contentAction, setContentAction] = useState<UserContentKind | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const createdInviteRef = useRef<HTMLDivElement>(null);

  function applyServerList(serverList: ServerPreset[]) {
    setServers(serverList);
    const savedId = readStorage(selectedPackStorageKey);
    const initial = serverList.find((server) => server.id === savedId)
      ?? serverList.find((server) => server.default)
      ?? serverList[0];
    setSelectedId(initial?.id ?? "");
  }

  async function loadCatalog(options: { quiet?: boolean } = {}) {
    if (!options.quiet) setCatalogState("loading");
    try {
      const serverList = await window.bweeep.listServers();
      applyServerList(serverList);
      setCatalogError("");
      setCatalogState(serverList.length > 0 ? "ready" : "error");
      if (serverList.length === 0) setCatalogError("지금 접속할 수 있는 서버가 없어요.");
    } catch (error) {
      if (options.quiet) return;
      applyServerList([]);
      setCatalogError(errorMessage(error, "서버 목록을 불러오지 못했어요."));
      setCatalogState("error");
    }
  }

  useEffect(() => {
    void Promise.allSettled([
      window.bweeep.defaultInstanceRoot(),
      window.bweeep.accessStatus(),
      window.bweeep.gameStatus(),
      window.bweeep.launcherChannel(),
      window.bweeep.launcherVersion(),
      window.bweeep.checkLauncherUpdate()
    ]).then(([root, status, initialGameStatus, channel, version, update]) => {
      const savedRoot = readStorage(instanceRootStorageKey);
      if (savedRoot) setInstanceRoot(savedRoot);
      else if (root.status === "fulfilled") setInstanceRoot(root.value);
      if (status.status === "fulfilled") {
        setAccess(status.value);
        setUser(status.value.user ?? null);
        setGameNameInput(status.value.user?.gameName ?? "");
      } else {
        setAccess({ loggedIn: false, allowed: false, isAdmin: false, unavailable: true, reason: "로그인 상태를 확인하지 못했습니다." });
      }
      if (initialGameStatus.status === "fulfilled") setGameStatus(initialGameStatus.value);
      if (channel.status === "fulfilled") setLauncherChannel(channel.value);
      if (version.status === "fulfilled") setLauncherVersion(version.value);
      if (update.status === "fulfilled") setLauncherUpdate(update.value);
    });
    void loadCatalog();
    const unsubscribeProgress = window.bweeep.onProgress((event: SyncProgress) => {
      setLogs((current) => [...current.slice(-199), { ...event, at: Date.now() }]);
      if (event.stage === "선택 서버 입장") setJoinedServer(true);
      if (event.stage === "서버 연결 종료" || event.stage === "서버 연결 끊김" || event.stage === "연결 종료") setJoinedServer(false);
      // Crashes arrive through the game status; progress errors cover install and connection failures.
      if (event.kind === "error" && event.stage !== "게임 종료") {
        setDockError({
          title: event.stage === "서버 접속 실패" ? "서버에 접속하지 못했어요"
            : event.stage === "서버 연결 끊김" ? "서버와 연결이 끊겼어요"
            : "게임을 시작하지 못했어요",
          message: event.message
        });
      }
    });
    const unsubscribeSession = window.bweeep.onAuthSession((nextUser: LauncherUser) => {
      setLoginPending(false);
      setEntryError("");
      setUser(nextUser);
      void refreshAccessStatus(nextUser);
      void loadCatalog();
    });
    const unsubscribeGameStatus = window.bweeep.onGameStatus((status) => {
      setGameStatus(status);
      if (status.state === "idle") setJoinedServer(false);
      if (status.exitError && status.exitMessage) setDockError(crashError(status));
    });
    // Why the server turned the player away; a crash stays the headline.
    const unsubscribeAuthFailure = window.bweeep.onAuthFailure((failure) => {
      setDockError((current) => current?.crash ? current : { title: "서버에 접속하지 못했어요", message: "", authFailure: failure.reason });
    });
    const unsubscribeError = window.bweeep.onAuthError((message) => {
      setLoginPending(false);
      setEntryError(message);
    });
    const unsubscribeUpdate = window.bweeep.onLauncherUpdate(setLauncherUpdate);
    const acceptInvite = (code: string) => {
      setInviteInput(code);
      setInviteError("");
    };
    const unsubscribeInvite = window.bweeep.onInviteReceived(acceptInvite);
    void window.bweeep.readyForInvite().then((code) => {
      if (code) acceptInvite(code);
    });
    return () => {
      unsubscribeProgress();
      unsubscribeSession();
      unsubscribeGameStatus();
      unsubscribeAuthFailure();
      unsubscribeError();
      unsubscribeUpdate();
      unsubscribeInvite();
    };
  }, []);

  // Fetch once per account/install location without blocking the launcher UI.
  // Library/apply responses refresh the character directly; no polling or 3D loop.
  useEffect(() => {
    const revision = ++skinRevision.current;
    let active = true;
    if (access?.allowed && user?.id && instanceRoot) {
      const owner = user.id;
      void window.bweeep.skinState(instanceRoot).then((state) => {
        if (active && revision === skinRevision.current) setProfileSkin({ owner, root: instanceRoot, state });
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [access?.allowed, user?.id, instanceRoot]);

  const visibleProfileSkin = profileSkin?.owner === user?.id && profileSkin?.root === instanceRoot ? profileSkin.state : null;

  useEffect(() => {
    if (!actionToast) return;
    const timer = window.setTimeout(() => setActionToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [actionToast]);

  useEffect(() => {
    if (!instanceRoot) return;
    void window.bweeep.userContentFolders(instanceRoot).then(setPersonalFolders).catch((error) => {
      setSettingsNotice(errorMessage(error, "개인 콘텐츠 폴더를 불러오지 못했습니다."));
    });
  }, [instanceRoot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmRequest) setConfirmRequest(null);
      else if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmRequest, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen || !user) return;
    setSettingsNotice("");
    void loadCatalog({ quiet: true });
    void refreshInvites();
  }, [settingsOpen]);

  useEffect(() => {
    if (createdInvite) createdInviteRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [createdInvite]);

  const availableServers = useMemo(
    () => servers.filter((server) => server.environment !== "test" || access?.testAllowed === true),
    [servers, access?.testAllowed]
  );
  const selected = useMemo(
    () => availableServers.find((server) => server.id === selectedId) ?? availableServers[0],
    [availableServers, selectedId]
  );
  const serverStatuses = useServerStatuses(availableServers);
  const offlineLaunchConsent = useOfflineLaunchConsent(serverStatuses.byId);
  const notice = useNotice(access?.allowed === true);

  // After an update, the new version's notes are shown once members reach the main screen.
  useEffect(() => {
    if (!access?.allowed) return;
    let active = true;
    void window.bweeep.whatsNew().then((next) => {
      if (active && next) setWhatsNew(next);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [access?.allowed]);

  function closeWhatsNew() {
    if (whatsNew) void window.bweeep.markWhatsNewSeen(whatsNew.version);
    setWhatsNew(null);
  }

  const canUseLauncher = Boolean(access?.allowed);
  const gameBusy = gameStatus.state !== "idle";
  const gameRunning = gameStatus.state === "running";
  const currentProgress = logs[logs.length - 1];
  const displayProgress: SyncProgress | undefined = gameRunning && (!currentProgress || currentProgress.stage === "모드팩 파일")
    ? { kind: "info", stage: "게임 프로세스", message: "창 여는 중" }
    : currentProgress;
  const showLaunchProgress = syncing || gameBusy;
  const progressPercent = !gameRunning
    && typeof displayProgress?.completed === "number"
    && typeof displayProgress.total === "number"
    && displayProgress.total > 0
      ? Math.round(Math.max(0, Math.min(1, displayProgress.completed / displayProgress.total)) * 100)
      : null;
  const progressTitle = gameRunning
    ? joinedServer ? "서버에서 플레이 중" : "게임 실행 중"
    : displayProgress?.stage ?? "준비 중";
  const progressDetail = gameRunning && joinedServer
    ? selected?.name ?? ""
    : stripStage(displayProgress?.stage, displayProgress?.message);
  // With the Bweeep login server the UUID belongs to the account, so renaming keeps the character.
  const savedGameName = user?.gameName ?? "";
  const serverState = describeServerState(catalogState, selected, selected ? serverStatuses.byId[selected.id] : undefined);

  async function refreshAccessStatus(fallbackUser: LauncherUser | null = user) {
    setAccessChecking(true);
    try {
      const status = await window.bweeep.accessStatus();
      setAccess(status);
      setUser(status.user ?? (status.loggedIn ? fallbackUser : null));
      setGameNameInput(status.user?.gameName ?? fallbackUser?.gameName ?? "");
    } catch (error) {
      const message = errorMessage(error, "접근 권한을 확인하지 못했습니다.");
      setAccess({
        loggedIn: Boolean(fallbackUser),
        allowed: false,
        isAdmin: false,
        unavailable: true,
        reason: message,
        user: fallbackUser ?? undefined
      });
    } finally {
      setAccessChecking(false);
    }
  }

  async function login() {
    if (loginPending) return;
    setEntryError("");
    setLoginPending(true);
    try {
      const result = await window.bweeep.login();
      if (!result.configured) {
        setLoginPending(false);
        setEntryError(result.message ?? "로그인 설정이 필요합니다.");
        return;
      }
      if (result.user) {
        setLoginPending(false);
        setUser(result.user);
        await refreshAccessStatus(result.user);
        void loadCatalog();
      }
    } catch (error) {
      setLoginPending(false);
      setEntryError(errorMessage(error, "로그인을 시작하지 못했습니다."));
    }
  }

  async function cancelLogin() {
    const result = await window.bweeep.cancelLogin();
    if (result.cancelled) setLoginPending(false);
  }

  async function redeemInvite() {
    if (redeeming) return;
    setInviteError("");
    setRedeeming(true);
    try {
      const code = normalizeInviteCode(inviteInput);
      const result = await window.bweeep.redeemInvite(code);
      if (result.ok) {
        setInviteInput("");
        setAccess({ ...result.status, user: result.status.user ?? user ?? undefined });
        await refreshAccessStatus(user);
        void loadCatalog();
      } else {
        setInviteError(result.message);
      }
    } catch (error) {
      setInviteError(errorMessage(error, "초대 코드를 사용할 수 없습니다."));
    } finally {
      setRedeeming(false);
    }
  }

  async function refreshInvites() {
    try {
      setInviteList(await window.bweeep.listInvites());
    } catch {
      // Older launcher-access deployments have no invite list; creating codes still works.
      setInviteList(null);
    }
  }

  const inviteRole = inviteList?.role ?? (access?.isAdmin ? "admin" : "member");
  const openInviteCount = inviteList?.invites.length ?? 0;
  const inviteLimitReached = inviteList?.activeLimit != null && openInviteCount >= inviteList.activeLimit;

  async function createInvite() {
    if (inviteBusy) return;
    setSettingsNotice("");
    setInviteBusy(true);
    try {
      setCreatedInvite(await window.bweeep.createInvite(inviteRole === "admin" ? inviteMaxUses : 1));
      setInviteCopied(false);
      setInviteLinkCopied(false);
      await refreshInvites();
    } catch (error) {
      setSettingsNotice(errorMessage(error, "초대 코드를 만들지 못했습니다."));
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setSettingsNotice("");
    try {
      await window.bweeep.revokeInvite(inviteId);
      if (createdInvite?.id === inviteId) setCreatedInvite(null);
      setActionToast("초대 코드 취소됨");
      await refreshInvites();
    } catch (error) {
      setSettingsNotice(errorMessage(error, "초대 코드를 취소하지 못했습니다."));
    }
  }

  async function copyInvite(kind: "code" | "link") {
    if (!createdInvite) return;
    try {
      await window.bweeep.copyText(kind === "code" ? createdInvite.code : "bwe-e-ep://invite/" + createdInvite.code);
      if (kind === "code") setInviteCopied(true);
      else setInviteLinkCopied(true);
    } catch (error) {
      setSettingsNotice(errorMessage(error, "클립보드에 복사하지 못했습니다."));
    }
  }

  function selectServer(nextId: string) {
    setSelectedId(nextId);
    writeStorage(selectedPackStorageKey, nextId);
  }

  async function logout() {
    try {
      const status = await window.bweeep.logout();
      setUser(null);
      setAccess(status);
      setCreatedInvite(null);
      setInviteList(null);
      setInviteCopied(false);
      setInviteLinkCopied(false);
      setSettingsOpen(false);
      setEntryError("");
    } catch (error) {
      setEntryError(errorMessage(error, "로그아웃하지 못했습니다."));
    }
  }

  const trimmedGameName = gameNameInput.trim();
  const gameNameValid = gameNamePattern.test(trimmedGameName);
  const gameNameChanged = trimmedGameName !== savedGameName;
  const gameNameHint = !trimmedGameName
    ? "영문, 숫자, 밑줄(_)로 3~16자를 입력해 주세요."
    : /[^A-Za-z0-9_]/.test(trimmedGameName)
      ? "영문, 숫자, 밑줄(_)만 쓸 수 있어요. 한글과 공백은 사용할 수 없어요."
      : trimmedGameName.length < 3
        ? "3자 이상 입력해 주세요."
        : "";

  function requestSaveGameProfile() {
    if (!gameNameValid || !gameNameChanged) return;
    void saveGameProfile();
  }

  async function saveGameProfile() {
    setSettingsNotice("");
    try {
      const saved = await window.bweeep.setGameProfile(trimmedGameName);
      setUser(saved);
      setAccess((current) => current ? { ...current, user: saved } : current);
      setGameNameInput(saved.gameName ?? "");
      setActionToast("이름 바뀜 · 다음 실행부터");
    } catch (error) {
      setSettingsNotice(errorMessage(error, "인게임 이름을 저장하지 못했습니다."));
    }
  }

  async function choosePersonalFolders(kind: UserContentKind) {
    if (contentAction) return;
    setContentAction(kind);
    setSettingsNotice("");
    try {
      const result = await window.bweeep.chooseUserContentFolders(instanceRoot.trim(), kind);
      setPersonalFolders(result.folders);
      if (result.selected > 0) {
        setActionToast((kind === "mods" ? "모드" : "셰이더") + " 폴더 추가됨");
      }
    } catch (error) {
      setSettingsNotice(errorMessage(error, "개인 콘텐츠 폴더를 저장하지 못했습니다."));
    } finally {
      setContentAction(null);
    }
  }

  async function openPersonalFolder(kind: UserContentKind) {
    const failure = await window.bweeep.openUserContentFolder(instanceRoot.trim(), kind).catch(() => "failed");
    if (failure) setSettingsNotice("폴더를 열지 못했어요.");
  }

  async function removePersonalFolder(kind: UserContentKind, folder: string) {
    if (contentAction) return;
    setContentAction(kind);
    setSettingsNotice("");
    try {
      const folders = await window.bweeep.removeUserContentFolder(instanceRoot.trim(), kind, folder);
      setPersonalFolders(folders);
      setActionToast((kind === "mods" ? "모드" : "셰이더") + " 폴더 빠짐");
    } catch (error) {
      setSettingsNotice(errorMessage(error, "개인 콘텐츠 폴더를 저장하지 못했습니다."));
    } finally {
      setContentAction(null);
    }
  }

  async function chooseInstanceRoot() {
    try {
      const picked = await window.bweeep.chooseInstanceRoot(instanceRoot);
      if (picked && picked !== instanceRoot) setMoveTarget(picked);
    } catch (error) {
      setSettingsNotice(errorMessage(error, "설치 위치를 바꾸지 못했습니다."));
    }
  }

  function switchInstanceRoot(root: string, moved: boolean) {
    setInstanceRoot(root);
    writeStorage(instanceRootStorageKey, root);
    setActionToast(moved ? "설치 위치 옮김" : "설치 위치 바뀜");
  }

  async function openInstanceRoot() {
    const failure = await window.bweeep.openPath(instanceRoot).catch(() => "failed");
    if (failure) setSettingsNotice("아직 설치된 파일이 없어요.");
  }

  async function copyLogs() {
    try {
      await window.bweeep.copyText(logs.map(formatLogLine).join("\n"));
      setActionToast("기록 복사됨");
    } catch (error) {
      setSettingsNotice(errorMessage(error, "클립보드에 복사하지 못했습니다."));
    }
  }

  function requestResetSettings() {
    setConfirmRequest({
      title: "런처 설정을 초기화할까요?",
      body: "서버 선택, 설치 위치, 기록만 초기화돼요. 게임 파일과 로그인은 그대로예요.",
      confirmLabel: "초기화",
      onConfirm: () => void resetSettings()
    });
  }

  async function resetSettings() {
    try {
      const root = await window.bweeep.defaultInstanceRoot();
      writeStorage(selectedPackStorageKey, null);
      writeStorage(instanceRootStorageKey, null);
      setSelectedId((servers.find((server) => server.default) ?? servers[0])?.id ?? "");
      setInstanceRoot(root);
      setLogs([]);
      setActionToast("설정 초기화됨");
    } catch (error) {
      setSettingsNotice(errorMessage(error, "설정을 초기화하지 못했습니다."));
    }
  }

  function requestStopGame() {
    setConfirmRequest({
      title: "게임을 강제로 종료할까요?",
      body: "마지막 저장 뒤의 진행은 사라질 수 있어요.",
      confirmLabel: "강제 종료",
      danger: true,
      onConfirm: () => {
        void window.bweeep.stopGame().catch((error) => {
          setDockError({ title: "게임을 종료하지 못했어요", message: errorMessage(error, "게임 프로세스를 종료하지 못했습니다.") });
        });
      }
    });
  }

  function dismissDockError() {
    setDockError(null);
    setGameStatus((current) => ({ state: current.state, pid: current.pid, startedAt: current.startedAt }));
  }

  /**
   * While the auth server is down nothing is installed or started: joining
   * needs it, so the player gets one line instead. An off server is started
   * only after one confirmation.
   */
  async function requestLaunch() {
    if (!selected || gameBusy || syncing || serverState === "closed") return;
    if (access?.outage) {
      const status = await window.bweeep.accessStatus().catch(() => null);
      if (status) setAccess(status);
      if (!status || status.outage) {
        setDockError({ title: authOutageMessages[status?.outage ?? access.outage], message: "", outage: true });
        return;
      }
    }
    if (serverState === "offline" && !offlineLaunchConsent.given(selected.id)) {
      const serverId = selected.id;
      setConfirmRequest({
        title: "서버가 꺼져 있어요",
        body: "그래도 시작할까요?",
        confirmLabel: "시작",
        onConfirm: () => {
          offlineLaunchConsent.give(serverId);
          void launchSelected();
        }
      });
      return;
    }
    void launchSelected();
  }

  async function launchSelected(options: { withoutPersonalMods?: boolean } = {}) {
    if (!selected || !instanceRoot.trim() || !canUseLauncher || gameBusy) return;
    setSyncing(true);
    setLogs([]);
    setDockError(null);
    setJoinedServer(false);
    try {
      await window.bweeep.launchGame({
        packId: selected.packId,
        instanceDir: instanceRoot.trim(),
        withoutPersonalMods: options.withoutPersonalMods,
        memoryMb: savedMemoryMb(selected.packId)
      });
      const currentStatus = await window.bweeep.gameStatus();
      setGameStatus(currentStatus);
      if (currentStatus.state === "idle" && currentStatus.exitError) setDockError(crashError(currentStatus));
    } catch (error) {
      const message = errorMessage(error, "게임을 시작하지 못했습니다.");
      setLogs((current) => [...current, { kind: "error", message, at: Date.now() }]);
      setDockError((current) => current ?? (authOutageFromMessage(message)
        ? { title: message, message: "" }
        : { title: "게임을 시작하지 못했어요", message }));
    } finally {
      setSyncing(false);
    }
  }

  const confirmDialog = confirmRequest && <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />;

  if (!access) {
    return (
      <EntryLayout eyebrow="붸에엡 런처" title="런처를 준비하고 있어요">
        <div className="entryStatus"><Spinner />잠시만요</div>
      </EntryLayout>
    );
  }

  if (!user) {
    return (
      <EntryLayout eyebrow="붸에엡 런처" title="로그인하고 시작하세요">
        <p className="entryDescription">친구 전용 서버예요.</p>
        <div className="entryActions">
          <button className="primaryButton entryPrimary" disabled={loginPending} onClick={() => void login()}>
            {loginPending ? <><Spinner />로그인 중</> : "Discord로 로그인"}
          </button>
          {loginPending && <p className="entryHint">브라우저에서 마치면 돌아와요.</p>}
          {loginPending && <button className="textButton" onClick={() => void cancelLogin()}>로그인 취소</button>}
        </div>
        {entryError && <p className="fieldError" role="alert">{entryError}</p>}
      </EntryLayout>
    );
  }

  if (access.unavailable) {
    return (
      <EntryLayout eyebrow="연결 확인" title="권한을 확인하지 못했어요">
        <p className="entryDescription">인터넷이나 서버 문제일 수 있어요.</p>
        <p className="entryDetail">{access.reason}</p>
        <div className="entryActions">
          <button className="primaryButton entryPrimary" disabled={accessChecking} onClick={() => void refreshAccessStatus(user)}>
            {accessChecking ? <><Spinner />확인 중</> : "다시 확인"}
          </button>
          <button className="textButton" onClick={() => void logout()}>다시 로그인</button>
        </div>
      </EntryLayout>
    );
  }

  if (!access.allowed) {
    return (
      <EntryLayout eyebrow="멤버 전용" title="초대 코드를 입력하세요">
        <p className="entryDescription">받은 초대 코드나 링크를 넣어 주세요.</p>
        <form
          className="entryInvite"
          onSubmit={(event) => {
            event.preventDefault();
            void redeemInvite();
          }}
        >
          <input
            aria-label="초대 코드"
            aria-invalid={Boolean(inviteError)}
            value={inviteInput}
            placeholder="BWEEP-XXXXXXXXXXXX-XXXXXXXXXXXX"
            onChange={(event) => {
              setInviteInput(event.target.value);
              setInviteError("");
            }}
          />
          <button className="primaryButton" type="submit" disabled={!inviteInput.trim() || redeeming}>
            {redeeming ? <Spinner /> : "참여"}
          </button>
        </form>
        {inviteError && <p className="fieldError" role="alert">{inviteError}</p>}
        <div className="entryActions">
          <button className="textButton" onClick={() => void logout()}>다른 계정으로 로그인</button>
        </div>
      </EntryLayout>
    );
  }

  // Test builds get updates before everyone else, so only designated testers use them.
  if (launcherChannel === "test" && !access.testAllowed) {
    return (
      <EntryLayout eyebrow="테스트 런처" title="지정된 테스터만 쓸 수 있어요">
        <p className="entryDescription">테스트용 런처예요. 일반 런처를 받아 주세요.</p>
        <div className="entryActions">
          <button className="primaryButton entryPrimary" onClick={() => void window.bweeep.openStableDownload()}>일반 런처 받기</button>
          <button className="textButton" onClick={() => void logout()}>다른 계정으로 로그인</button>
        </div>
      </EntryLayout>
    );
  }

  const closeSettings = () => setSettingsOpen(false);
  const settingsSections: SettingsSection[] = settingsOpen ? [
    { id: "account", label: "내 계정", icon: <SettingsIcon kind="account" />, content: (
      <section className="embeddedPanel profileModal" aria-label="계정">
            <header className="modalHeader">
              <div className="profileHeading">
                <ProfileAvatar skin={visibleProfileSkin} />
                <div>
                  <p className="eyebrow">계정</p>
                  <h2>{user.globalName ?? user.username}</h2>
                  <small>Discord로 로그인됨</small>
                </div>
              </div>
            </header>
        <div className="modalBody">
              <section className="panel">
                <div className="panelHeader">
                  <h3>인게임 이름</h3>
                  <span>모든 서버에서 이 이름으로 접속해요.</span>
                </div>
                <form
                  className="nameRow"
                  onSubmit={(event) => {
                    event.preventDefault();
                    requestSaveGameProfile();
                  }}
                >
                  <input
                    aria-label="인게임 이름"
                    aria-invalid={Boolean(trimmedGameName) && !gameNameValid}
                    maxLength={16}
                    value={gameNameInput}
                    placeholder="영문·숫자·밑줄 3~16자"
                    onChange={(event) => setGameNameInput(event.target.value)}
                  />
                  <button className="primaryButton" type="submit" disabled={!gameNameValid || !gameNameChanged}>저장</button>
                </form>
                {gameNameHint && gameNameChanged && <p className="fieldError">{gameNameHint}</p>}
                {savedGameName && gameNameChanged && gameNameValid && (
                  <p className="fieldNote">{savedGameName}은(는) 하루 동안 내 이름으로 남아요.</p>
                )}
              </section>
        </div>
        <footer className="modalFooter"><button className="textButton dangerText" onClick={() => void logout()}>Discord 로그아웃</button></footer>
      </section>
    ) },
    { id: "skin", label: "캐릭터 스킨", icon: <SettingsIcon kind="skin" />, content: (
      <Suspense fallback={<div className="settingsLoading">스킨 정보를 불러오는 중…</div>}>
        <SkinPanel embedded instanceRoot={instanceRoot} serverShowsSkins={selected?.gameAuth === "yggdrasil"}
          onStateChange={(state) => { skinRevision.current += 1; setProfileSkin({ owner: user.id, root: instanceRoot, state }); }}
          onClose={closeSettings} />
      </Suspense>
    ) },
    { id: "game", label: "게임 및 파일", icon: <SettingsIcon kind="game" />, content: (
      <section className="embeddedPanel settingsModal" aria-label="게임 및 파일">
        <header className="modalHeader"><div><p className="eyebrow">게임 설정</p><h2>게임 및 파일</h2></div></header>
        <div className="modalBody">
          {selected && <article className="panel selectedEnvironment"><div className="panelHeader"><h3>선택한 서버</h3><span>메인 화면의 서버 카드에서 바꿀 수 있어요.</span></div><strong>{selected.name}</strong><p>Minecraft {selected.minecraftVersion} · {serverKindLabel(selected)} · {loaderLabel(selected.loader.kind)} 클라이언트 {selected.loader.kind !== "vanilla" ? selected.loader.version : ""}</p></article>}
              <MemoryPanel servers={availableServers} />

              <article className="panel">
                <div className="panelHeader">
                  <h3>설치 위치</h3>
                  <span>게임 파일을 받는 폴더예요.</span>
                </div>
                <div className="pathRow">
                  <p className="pathValue" title={instanceRoot}>{instanceRoot || "-"}</p>
                  <button className="secondaryButton" disabled={gameBusy} onClick={() => void chooseInstanceRoot()}>변경</button>
                  <button className="secondaryButton" onClick={() => void openInstanceRoot()}>폴더 열기</button>
                </div>
              </article>

              <section className="panel">
                <div className="panelHeader">
                  <h3>내 모드와 셰이더</h3>
                  <span>게임을 시작할 때 이 폴더의 파일을 함께 넣어요.</span>
                </div>
                <div className="contentFolderGroups">
                  {(["mods", "shaderpacks"] as const).map((kind) => (
                    <div className="contentFolderGroup" key={kind}>
                      <div className="contentFolderLabel">
                        <strong>{kind === "mods" ? "모드 폴더" : "셰이더 폴더"}</strong>
                        <span>{kind === "mods" ? ".jar" : ".zip"} 파일 · 여러 폴더 가능</span>
                      </div>
                      <div className="contentFolderList">
                        {personalFolders[kind].length === 0 ? <p>선택한 폴더가 없어요.</p> : personalFolders[kind].map((folder) => (
                          <div className="contentFolderItem" key={folder} title={folder}>
                            <span>{shortenPath(folder)}</span>
                            <button aria-label={`${kind === "mods" ? "모드" : "셰이더"} 폴더 제거`} disabled={contentAction !== null} onClick={() => void removePersonalFolder(kind, folder)}>×</button>
                          </div>
                        ))}
                      </div>
                      <button className="secondaryButton contentFolderAdd" disabled={!instanceRoot.trim() || contentAction !== null} onClick={() => void choosePersonalFolders(kind)}>
                        {contentAction === kind ? "저장 중…" : `${kind === "mods" ? "모드" : "셰이더"} 폴더 선택`}
                      </button>
                      {kind === "shaderpacks" && (
                        <button className="secondaryButton contentFolderAdd" disabled={!instanceRoot.trim()} onClick={() => void openPersonalFolder(kind)}>
                          폴더 열기
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mutedText">서버와 같은 버전·로더용만 넣어 주세요.</p>
              </section>
              <section className="panel logPanel">
                <div className="panelHeader">
                  <h3>설치 기록</h3>
                  {logs.length > 0 && <button className="secondaryButton" onClick={() => void copyLogs()}>복사</button>}
                </div>
                <div className="log">
                  {logs.length === 0 ? (
                    <p className="empty">아직 기록이 없어요.</p>
                  ) : (
                    logs.map((entry, index) => (
                      <p className={`logLine ${entry.kind}`} key={`${entry.at}-${index}`}>
                        <time>{formatClock(entry.at)}</time>
                        {entry.stage && <b>{entry.stage}</b>}
                        <span>{stripStage(entry.stage, entry.message)}</span>
                      </p>
                    ))
                  )}
                </div>
              </section>
        </div>
        <footer className="modalFooter"><button className="textButton" onClick={requestResetSettings}>설정 초기화</button></footer>
      </section>
    ) },
    ...(selected ? [{ id: "mods", label: "편의 모드", icon: <SettingsIcon kind="mods" />, content: <ModsPanel embedded server={selected} instanceRoot={instanceRoot} onClose={closeSettings} /> }] : []),
    { id: "community", label: "연결 및 초대", icon: <SettingsIcon kind="community" />, content: (
      <section className="embeddedPanel communityPanel" aria-label="연결 및 초대">
        <header className="modalHeader"><div><p className="eyebrow">함께 플레이</p><h2>연결 및 초대</h2></div></header>
        <div className="modalBody"><DiscordPresencePanel />
              <article className="panel">
                <div className="panelHeader">
                  <h3>친구 초대</h3>
                  <span>
                    {inviteRole === "admin"
                      ? "관리자 · 여러 명이 함께 쓰는 코드를 만들 수 있어요."
                      : `1회용 코드 · 7일 동안 유효${inviteList?.activeLimit != null ? ` · 사용 전 코드 최대 ${inviteList.activeLimit}개` : ""}`}
                  </span>
                </div>
                <div className="inviteCreateRow">
                  {inviteRole === "admin" && (
                    <div className="segmented" role="radiogroup" aria-label="사용 인원">
                      {adminInviteSizes.filter((size) => size <= (inviteList?.maxUsesLimit ?? 20)).map((size) => (
                        <button
                          key={size}
                          role="radio"
                          aria-checked={inviteMaxUses === size}
                          className={inviteMaxUses === size ? "active" : ""}
                          onClick={() => setInviteMaxUses(size)}
                        >
                          {size}명
                        </button>
                      ))}
                    </div>
                  )}
                  <button className="primaryButton" disabled={inviteBusy || inviteLimitReached} onClick={() => void createInvite()}>
                    {inviteBusy ? <Spinner /> : null}
                    {inviteRole === "admin" ? `${inviteMaxUses}명용 초대 만들기` : "초대 코드 만들기"}
                  </button>
                  {inviteLimitReached && <span className="mutedText">안 쓴 코드가 {inviteList?.activeLimit}개예요. 하나를 취소하면 새로 만들 수 있어요.</span>}
                </div>
                {createdInvite && (
                  <div className="createdInvite" ref={createdInviteRef}>
                    <code>{createdInvite.code}</code>
                    <div className="createdInviteActions">
                      <button className="secondaryButton" onClick={() => void copyInvite("code")}>{inviteCopied ? "복사됨" : "코드 복사"}</button>
                      <button className="secondaryButton" onClick={() => void copyInvite("link")}>{inviteLinkCopied ? "링크 복사됨" : "링크 복사"}</button>
                    </div>
                    <small>{createdInvite.maxUses === 1 ? "1회용" : `${createdInvite.maxUses}명까지`} · {formatDate(createdInvite.expiresAt)} 만료 · 지금만 보여요</small>
                  </div>
                )}
                {inviteList && inviteList.invites.length > 0 && (
                  <div className="inviteList">
                    <p className="inviteListTitle">사용 전 초대 코드 {inviteList.invites.length}개</p>
                    {inviteList.invites.map((invite) => (
                      <div className="inviteItem" key={invite.id}>
                        <span>
                          {invite.maxUses === 1 ? "1회용" : `${invite.uses}/${invite.maxUses}명 사용`}
                          {" · "}{formatDate(invite.createdAt)} 생성 · {formatDate(invite.expiresAt)} 만료
                        </span>
                        <button className="textButton" onClick={() => void revokeInvite(invite.id)}>취소</button>
                      </div>
                    ))}
                  </div>
                )}
              </article>

        </div>
      </section>
    ) },
    { id: "patch", label: "패치노트", icon: <SettingsIcon kind="patch" />, content: <PatchNotesPanel embedded onClose={closeSettings} /> },
    ...(access.isAdmin ? [{ id: "admin", label: "관리", icon: <SettingsIcon kind="admin" />, content: <AdminPanel embedded selfId={user.id} onClose={closeSettings} confirm={setConfirmRequest} onNoticeChange={notice.replace} /> }] : [])
  ] : [];

  return (
    <main className="shell">
      <header className="launcherHeader topbar">
        <div className="brand" aria-label="붸에엡 런처"><img className="launcherMark" src={launcherIconUrl} alt="" /></div>
        {notice.shown && (
          <LauncherNoticeBanner
            key={JSON.stringify([notice.shown.id, notice.shown.text, notice.shown.at, settingsOpen, Boolean(confirmRequest)])}
            notice={notice.shown}
            onDismiss={notice.dismiss}
          />
        )}
        <UpdateIndicator status={launcherUpdate} />
          <div className="topbarActions">
            <button className="profileBox" aria-haspopup="dialog" aria-label="프로필 및 설정 열기" onClick={() => setSettingsOpen(true)}>
              <ProfileAvatar skin={visibleProfileSkin} />
              <div>
                <strong>{user.globalName ?? user.username}</strong>
                <small>{savedGameName ? `인게임 · ${savedGameName}` : "인게임 이름 미설정"}</small>
              </div>
            </button>
            <WindowControls />
          </div>
      </header>
      <aside className="sidebar" aria-label="서버 라이브러리">
        <div className="libraryHeading"><span>내 서버</span><small>{availableServers.length.toString().padStart(2, "0")}</small></div>
        <div className="serverLibrary" role="group" aria-label="내 서버">
          {availableServers.map((server) => (
            <button key={server.id} className={`libraryCard${server.id === selected?.id ? " isSelected" : ""}${server.environment === "test" ? " isTest" : ""}`} aria-pressed={server.id === selected?.id} disabled={gameBusy || syncing} onClick={() => selectServer(server.id)}>
              <span className="libraryCardArt" aria-hidden="true" />
              <span className="libraryCardCopy">
                <strong>{server.name}</strong>
                <small>Minecraft {server.minecraftVersion}{server.environment === "test" ? " · 테스트" : ""}</small>
                <ServerConnectionBadge status={serverStatuses.byId[server.id]} />
              </span>
              {server.id === selected?.id && <span className="librarySelected" aria-hidden="true" />}
            </button>
          ))}
          {catalogState === "loading" && !availableServers.length && <p className="libraryEmpty">서버를 불러오는 중…</p>}
          {catalogState === "error" && !availableServers.length && <button className="libraryRetry" onClick={() => void loadCatalog()}>서버 목록 다시 불러오기</button>}
        </div>

      </aside>
      <section className="content">
        <section className="hero">
          <div className="heroArtwork" aria-hidden="true">
            <div className="heroBackdrop" />
            <span className="artworkEdition">MINECRAFT JAVA EDITION</span>
          </div>
          <div className="heroFooter">
            <div className="heroCopy" key={selected?.id ?? catalogState}>
              {catalogState === "error" ? (
                <>
                  <p className="eyebrow">서버 목록</p>
                  <h2>서버에 연결하지 못했어요</h2>
                  <p>인터넷을 확인해 주세요. ({catalogError})</p>
                  <button className="secondaryButton heroRetry" onClick={() => void loadCatalog()}>다시 불러오기</button>
                </>
              ) : catalogState === "loading" && !selected ? (
                <>
                  <p className="eyebrow">서버 목록</p>
                  <h2>서버를 불러오는 중</h2>
                </>
              ) : selected && (
                <>
                  <p className="eyebrow">{selected.environment === "test" ? "TEST SERVER" : "YOUR NEXT ADVENTURE"}</p>
                  <h2>{selected.name}</h2>
                  <p>{selected.description || "필요한 파일을 확인한 뒤 선택한 서버로 접속합니다."}</p>
                  <div className="chips">
                    <span>Minecraft {selected.minecraftVersion}</span>
                    <span>{serverKindLabel(selected)}</span>
                    <span>{selected.environment === "test" ? "지정 테스터 전용" : "멤버 전용"}</span>
                  </div>
                </>
              )}
            </div>
            <div className="actionDock" aria-live="polite">
              {actionToast && !settingsOpen && <div className="actionToast" role="status">{actionToast}</div>}
              {dockError && !gameBusy && !syncing && (
                <div className="dockError" role="alert">
                  <div>
                    <strong>{dockError.title}</strong>
                    {dockError.authFailure ? <AuthFailureLine reason={dockError.authFailure} /> : dockError.message && <p>{dockError.message}</p>}
                    {!dockError.outage && <DiagnosticsButton key={`${dockError.title}|${dockError.message}|${dockError.authFailure ?? ""}`} />}
                  </div>
                  <div className="dockErrorActions">
                    {dockError.retryWithoutPersonalMods && (
                      <button className="secondaryButton" onClick={() => void launchSelected({ withoutPersonalMods: true })}>개인 모드 빼고 시작</button>
                    )}
                    {dockError.message && <button className="secondaryButton" onClick={() => void window.bweeep.openLog("game")}>로그 열기</button>}
                    <button className="iconOnly" aria-label="오류 닫기" onClick={dismissDockError}>×</button>
                  </div>
                </div>
              )}
              {!dockError && !gameBusy && !syncing && access.outage && (
                <p className="dockHint">{access.outage === "auth" ? "인증 서버 점검 중" : "인터넷 연결 끊김"}</p>
              )}
              {!dockError && !gameBusy && !syncing && serverState === "closed" && selected && serverStatuses.byId[selected.id]?.closed && (
                <p className="dockHint">{closedMessage(serverStatuses.byId[selected.id].closed!.nextOpen)}</p>
              )}
              {showLaunchProgress && (
                <div className={`launchProgress${gameRunning && joinedServer ? " isPlaying" : ""}`} role="status">
                  <div className="launchProgressHeading">
                    <strong>{progressTitle}</strong>
                    <span>{progressPercent !== null ? `${progressPercent}%` : gameStatus.startedAt ? <ElapsedTime startedAt={gameStatus.startedAt} /> : ""}</span>
                  </div>
                  {progressDetail && <small title={progressDetail}>{progressDetail}</small>}
                  {!(gameRunning && joinedServer) && <progress className="launchProgressBar" max={100} value={progressPercent ?? undefined} />}
                </div>
              )}
              <div className="launchRow">
                <button className="launchButton" disabled={!selected || !canUseLauncher || syncing || gameBusy || serverState === "closed"} aria-busy={showLaunchProgress} onClick={() => void requestLaunch()}>
                  {gameRunning ? "게임 실행 중" : showLaunchProgress ? <><Spinner />게임 시작 중</> : serverState === "offline" ? <><ServerOffIcon />게임 시작</> : <><svg className="launchPlayIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>게임 시작</>}
                </button>
                {gameRunning && gameStatus.pid && (
                  <button className="stopButton" onClick={requestStopGame}>게임 종료</button>
                )}
              </div>
            </div>
          </div>
        </section>
      </section>

      {settingsOpen && <SettingsHub sections={settingsSections} version={launcherVersion} notice={actionToast} error={settingsNotice} onClose={closeSettings} />}

      {moveTarget && (
        <InstallMoveDialog from={instanceRoot} to={moveTarget} onSwitch={switchInstanceRoot} onClose={() => setMoveTarget(null)} />
      )}

      {whatsNew && !confirmRequest && <WhatsNewDialog whatsNew={whatsNew} onClose={closeWhatsNew} />}
      {confirmDialog}
    </main>
  );
}

function normalizeInviteCode(value: string): string {
  const trimmed = value.trim();
  const fromLink = trimmed.match(/invite\/([A-Za-z0-9-]+)/);
  return (fromLink ? fromLink[1] : trimmed).toUpperCase();
}

function LauncherNoticeBanner({ notice, onDismiss }: { notice: LauncherNotice; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExpanded(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  return (
    <section ref={container} className={`topbarNotice${notice.personal ? " isPersonal" : ""}${expanded ? " isExpanded" : ""}`} role="status" aria-label="공지사항" title={notice.personal ? "나에게만 온 공지" : "전체 공지"}>
      <button ref={toggle} type="button" className="noticeToggle" aria-expanded={expanded} aria-controls={detailsId} aria-describedby={`${detailsId}-preview`} aria-label={`공지 전체 내용 ${expanded ? "접기" : "펼치기"}`} onClick={() => setExpanded((current) => !current)}>
        <svg className="noticeIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l6 4V6l-6 4z" /><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10" /></svg>
        <span className="noticeText">
          <span className="noticeMeta"><strong>공지사항</strong><span>{notice.personal ? "나에게만" : "전체 공지"}</span><time dateTime={notice.at}>{formatDate(notice.at)}</time></span>
          <span id={`${detailsId}-preview`} className="noticePreview">{notice.text.replace(/\s+/g, " ").trim()}</span>
        </span>
        <svg className="noticeChevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button type="button" className="iconOnly noticeClose" aria-label="공지 닫기" onClick={onDismiss}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
      <div id={detailsId} className="noticeDetails" role="region" aria-label="공지 전체 내용" hidden={!expanded} tabIndex={0}>
        <p>{notice.text}</p>
      </div>
    </section>
  );
}

function stripStage(stage: string | undefined, message: string | undefined): string {
  if (!message) return "";
  if (!stage || !message.startsWith(stage)) return message;
  return message.slice(stage.length).replace(/^[\s:·-]+/, "");
}

function loaderLabel(kind: LoaderKind | ServerSoftwareKind): string {
  const labels: Record<string, string> = {
    vanilla: "바닐라",
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
    paper: "Paper",
    folia: "Folia"
  };
  return labels[kind] ?? kind;
}

function serverKindLabel(server: ServerPreset): string {
  const kind = server.serverLoader?.kind ?? server.loader.kind;
  return kind === "vanilla" ? "바닐라 서버" : `${loaderLabel(kind)} 서버`;
}

/**
 * Launcher self-update: an icon, and the percent while downloading. Nothing
 * else is written on screen; the words are only the label and tooltip.
 */
function UpdateIndicator({ status }: { status: LauncherUpdateStatus | null }) {
  const state = status?.state;
  if (state !== "checking" && state !== "available" && state !== "downloading" && state !== "ready" && state !== "installing") return null;
  const downloading = state === "available" || state === "downloading";
  const label = state === "checking" ? "업데이트 확인 중"
    : downloading ? "업데이트 받는 중"
    : state === "ready" ? "업데이트 준비됨"
    : "다시 시작하는 중";
  const version = status?.update?.version ? ` v${status.update.version}` : "";
  // A ready update installs by itself when the game is closed normally; after a crash it waits for this click.
  if (state === "ready") {
    return (
      <button
        type="button"
        className="updateIndicator is-ready"
        aria-label={label}
        title={`${label}${version} · 눌러서 다시 시작`}
        onClick={() => void window.bweeep.installLauncherUpdate()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
      </button>
    );
  }
  return (
    <div className={`updateIndicator is-${state}`} role="status" aria-label={label} title={`${label}${version}`}>
      {state === "checking" ? <span className="spinner" aria-hidden="true" />
        : downloading ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>}
      {downloading && <span>{status?.percent ?? 0}%</span>}
    </div>
  );
}

function shortenPath(value: string): string {
  if (value.length <= 40) return value;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-2).join("\\");
  return `${parts[0]}\\…\\${tail}`;
}

/**
 * The play timer. Only this text re-renders each second, so the whole launcher
 * does not repaint next to the game, and nothing ticks while the window is hidden.
 */
function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1_000);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, []);
  return <>{formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1_000)))}</>;
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

function formatLogLine(entry: LogEntry): string {
  return [formatClock(entry.at), entry.stage, stripStage(entry.stage, entry.message)].filter(Boolean).join("  ");
}

createRoot(document.getElementById("root")!).render(<App />);
