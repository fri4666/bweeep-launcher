import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessStatus,
  CreatedInvite,
  GameStatus,
  InviteList,
  LauncherUpdateStatus,
  LauncherUser,
  LoaderKind,
  MemberSummary,
  ServerConnection,
  ServerPreset,
  ServerSoftwareKind,
  ServerStatus,
  SyncProgress,
  UserContentFolders,
  UserContentKind,
  WhatsNew
} from "../shared/types.js";
import "pretendard/dist/web/variable/pretendardvariable.css";
import "./styles.css";
import { ModsPanel } from "./ModsPanel.js";
import { PatchNotesPanel, ReleaseNoteSections } from "./PatchNotesPanel.js";

// The 3D skin preview brings in three.js, so it loads when the skin tab first opens.
const SkinPanel = lazy(() => import("./SkinPanel.js").then((module) => ({ default: module.SkinPanel })));

const selectedPackStorageKey = "bweeep.selected-pack-id";
const instanceRootStorageKey = "bweeep.instance-root";
const gameNamePattern = /^[A-Za-z0-9_]{3,16}$/;
const adminInviteSizes = [1, 5, 10, 20];

type LogEntry = SyncProgress & { at: number };
type CatalogState = "loading" | "ready" | "error";
type DockError = { title: string; message: string; retryWithoutPersonalMods?: boolean };
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
    retryWithoutPersonalMods: Boolean(status.retryWithoutPersonalMods)
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

function ProfileAvatar({ user }: { user: LauncherUser }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showDiscordAvatar = Boolean(user.avatarUrl) && !imageFailed;

  if (showDiscordAvatar) {
    return <img src={user.avatarUrl!} alt="" onError={() => setImageFailed(true)} />;
  }

  return (
    <span className="avatarFallback" aria-label="기본 프로필 이미지">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.8-3.4 3.1-5.2 7-5.2s6.2 1.8 7 5.2" />
      </svg>
    </span>
  );
}

function EntryLayout({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <main className="entryScreen">
      <WindowControls />
      <section className="entryCard">
        <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
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
        <p className="eyebrow">업데이트 완료 · v{whatsNew.version}</p>
        <h2>이번 버전에서 바뀐 점</h2>
        {whatsNew.summary && <p className="whatsNewSummary">{whatsNew.summary}</p>}
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
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverChecking, setServerChecking] = useState(false);
  const [serverCheckedAt, setServerCheckedAt] = useState<number | null>(null);
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
  const [profileNotice, setProfileNotice] = useState("");
  const [actionToast, setActionToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [patchNotesOpen, setPatchNotesOpen] = useState(false);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [testerBusyId, setTesterBusyId] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);
  const [launcherChannel, setLauncherChannel] = useState<"production" | "test">("production");
  const [launcherVersion, setLauncherVersion] = useState("");
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null);
  const [gameStatus, setGameStatus] = useState<GameStatus>({ state: "idle" });
  const [clockNow, setClockNow] = useState(Date.now());
  const [gameNameInput, setGameNameInput] = useState("");
  const [personalFolders, setPersonalFolders] = useState<UserContentFolders>({ mods: [], shaderpacks: [] });
  const [contentAction, setContentAction] = useState<UserContentKind | null>(null);
  const createdInviteRef = useRef<HTMLDivElement>(null);

  function applyServerList(serverList: ServerPreset[]) {
    setServers(serverList);
    const savedId = readStorage(selectedPackStorageKey);
    const initial = serverList.find((server) => server.id === savedId)
      ?? serverList.find((server) => server.default)
      ?? serverList[0];
    setSelectedId(initial?.id ?? "");
    setServerStatus(null);
    setServerCheckedAt(null);
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
      if (event.stage === "서버 연결 종료" || event.stage === "연결 종료") setJoinedServer(false);
      // Crashes arrive through the game status; progress errors cover install and connection failures.
      if (event.kind === "error" && event.stage !== "게임 종료") {
        setDockError({
          title: event.stage === "서버 접속 실패" ? "서버에 접속하지 못했어요" : "게임을 시작하지 못했어요",
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
      unsubscribeError();
      unsubscribeUpdate();
      unsubscribeInvite();
    };
  }, []);

  useEffect(() => {
    if (!actionToast) return;
    const timer = window.setTimeout(() => setActionToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [actionToast]);

  useEffect(() => {
    if (!instanceRoot) return;
    void window.bweeep.userContentFolders(instanceRoot).then(setPersonalFolders).catch((error) => {
      setProfileNotice(errorMessage(error, "개인 콘텐츠 폴더를 불러오지 못했습니다."));
    });
  }, [instanceRoot]);

  useEffect(() => {
    if (gameStatus.state === "idle") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [gameStatus.state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmRequest) setConfirmRequest(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (profileOpen) setProfileOpen(false);
      else if (skinOpen) setSkinOpen(false);
      else if (modsOpen) setModsOpen(false);
      else if (patchNotesOpen) setPatchNotesOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmRequest, settingsOpen, profileOpen, skinOpen, modsOpen, patchNotesOpen]);

  const refreshServerStatus = useCallback(async (nextConnection: ServerConnection) => {
    setServerChecking(true);
    try {
      setServerStatus(await window.bweeep.serverStatus(nextConnection));
    } catch {
      setServerStatus({
        online: false,
        host: nextConnection.host,
        port: nextConnection.port,
        message: "연결 끊김"
      });
    } finally {
      setServerCheckedAt(Date.now());
      setServerChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen || !user) return;
    setSettingsNotice("");
    void loadCatalog({ quiet: true });
    void refreshInvites();
    if (access?.isAdmin) {
      window.bweeep.listMembers().then(setMembers).catch((error) => setSettingsNotice(errorMessage(error, "멤버 목록을 불러오지 못했어요.")));
    }
  }, [settingsOpen]);

  async function toggleTester(member: MemberSummary) {
    setTesterBusyId(member.userId);
    setSettingsNotice("");
    try {
      setMembers(await window.bweeep.setTester(member.userId, !member.tester));
    } catch (error) {
      setSettingsNotice(errorMessage(error, "테스터 지정을 저장하지 못했어요."));
    } finally {
      setTesterBusyId(null);
    }
  }

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
  const connection = useMemo<ServerConnection | null>(
    () => selected ? { host: selected.server.host, port: selected.server.port } : null,
    [selected?.server.host, selected?.server.port]
  );

  useEffect(() => {
    if (!connection) return;
    let checkInFlight = false;
    const check = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        await refreshServerStatus(connection);
      } finally {
        checkInFlight = false;
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 5_000);
    return () => window.clearInterval(interval);
  }, [connection, refreshServerStatus]);

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
  const elapsedSeconds = gameStatus.startedAt ? Math.max(0, Math.floor((clockNow - gameStatus.startedAt) / 1_000)) : null;
  const progressTitle = gameRunning
    ? joinedServer ? "서버에서 플레이 중" : "게임 실행 중"
    : displayProgress?.stage ?? "준비 중";
  const progressDetail = gameRunning && joinedServer
    ? selected?.name ?? ""
    : stripStage(displayProgress?.stage, displayProgress?.message);
  // With the Bweeep login server the UUID belongs to the account, so renaming keeps the character.
  const savedGameName = user?.gameName ?? "";
  const serverState = catalogState === "error"
    ? "catalogError"
    : catalogState === "loading" || !connection
      ? "loading"
      : serverStatus
        ? serverStatus.online ? "online" : "offline"
        : "checking";

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
      setProfileOpen(false);
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
    setProfileNotice("");
    try {
      const saved = await window.bweeep.setGameProfile(trimmedGameName);
      setUser(saved);
      setAccess((current) => current ? { ...current, user: saved } : current);
      setGameNameInput(saved.gameName ?? "");
      setActionToast("이름 바뀜 · 다음 실행부터");
    } catch (error) {
      setProfileNotice(errorMessage(error, "인게임 이름을 저장하지 못했습니다."));
    }
  }

  async function choosePersonalFolders(kind: UserContentKind) {
    if (contentAction) return;
    setContentAction(kind);
    setProfileNotice("");
    try {
      const result = await window.bweeep.chooseUserContentFolders(instanceRoot.trim(), kind);
      setPersonalFolders(result.folders);
      if (result.selected > 0) {
        setActionToast((kind === "mods" ? "모드" : "셰이더") + " 폴더 추가됨");
      }
    } catch (error) {
      setProfileNotice(errorMessage(error, "개인 콘텐츠 폴더를 저장하지 못했습니다."));
    } finally {
      setContentAction(null);
    }
  }

  async function removePersonalFolder(kind: UserContentKind, folder: string) {
    if (contentAction) return;
    setContentAction(kind);
    setProfileNotice("");
    try {
      const folders = await window.bweeep.removeUserContentFolder(instanceRoot.trim(), kind, folder);
      setPersonalFolders(folders);
      setActionToast((kind === "mods" ? "모드" : "셰이더") + " 폴더 빠짐");
    } catch (error) {
      setProfileNotice(errorMessage(error, "개인 콘텐츠 폴더를 저장하지 못했습니다."));
    } finally {
      setContentAction(null);
    }
  }

  async function chooseInstanceRoot() {
    try {
      const picked = await window.bweeep.chooseInstanceRoot(instanceRoot);
      if (!picked) return;
      setInstanceRoot(picked);
      writeStorage(instanceRootStorageKey, picked);
      setActionToast("설치 위치 바뀜");
    } catch (error) {
      setSettingsNotice(errorMessage(error, "설치 위치를 바꾸지 못했습니다."));
    }
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

  async function launchSelected(options: { withoutPersonalMods?: boolean } = {}) {
    if (!selected || !instanceRoot.trim() || !canUseLauncher || gameBusy) return;
    setSyncing(true);
    setLogs([]);
    setDockError(null);
    setJoinedServer(false);
    try {
      await window.bweeep.launchGame({ packId: selected.packId, instanceDir: instanceRoot.trim(), withoutPersonalMods: options.withoutPersonalMods });
      const currentStatus = await window.bweeep.gameStatus();
      setGameStatus(currentStatus);
      if (currentStatus.state === "idle" && currentStatus.exitError) setDockError(crashError(currentStatus));
    } catch (error) {
      const message = errorMessage(error, "게임을 시작하지 못했습니다.");
      setLogs((current) => [...current, { kind: "error", message, at: Date.now() }]);
      setDockError((current) => current ?? { title: "게임을 시작하지 못했어요", message });
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

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark" aria-label="붸에엡">
            <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
          </span>
          <div>
            <p className="eyebrow">Minecraft 런처</p>
            <h1 className="brandWord">붸에엡</h1>
          </div>
        </div>

        <nav className="sideActions" aria-label="메뉴">
          <button className="sideAction" onClick={() => setProfileOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.4 3.1-5.2 7-5.2s6.2 1.8 7 5.2" /></svg>
            <span>계정</span>
          </button>
          <button className="sideAction" onClick={() => setSkinOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="7" rx="1" /><path d="M7 21v-9h10v9M4 12h3v6H4zM17 12h3v6h-3z" /></svg>
            <span>스킨</span>
          </button>
          <button className="sideAction" disabled={!selected} onClick={() => setModsOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
            <span>편의 모드</span>
          </button>
          <button className="sideAction" onClick={() => setPatchNotesOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>
            <span>패치노트</span>
          </button>
          <button className="sideAction" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
            <span>설정</span>
          </button>
        </nav>
        <div className="supportPanel">
          <span className="accessStamp">멤버 전용</span>
          <strong>함께하는 서버</strong>
          <p>초대받은 친구들과 같은 Minecraft 버전으로 바로 접속할 수 있어요.</p>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className={`serverPill is-${serverState}`}>
            <span className="statusDot" />
            <div>
              <strong>{serverStateLabel(serverState)}</strong>
              <small>
                {serverState === "online" && serverCheckedAt
                  ? `${serverStatus?.latencyMs ?? "-"}ms · ${formatRelativeTime(serverCheckedAt, clockNow)} 확인`
                  : serverState === "offline"
                    ? "연결 안 됨"
                    : serverState === "catalogError"
                      ? "목록을 못 받았어요"
                      : "잠시만요"}
              </small>
            </div>
            {(serverState === "offline" || serverState === "catalogError") && (
              <button
                className="pillAction"
                disabled={serverChecking}
                onClick={() => serverState === "catalogError" ? void loadCatalog() : connection && void refreshServerStatus(connection)}
              >
                {serverChecking ? "확인 중" : "다시 확인"}
              </button>
            )}
          </div>
          <UpdateIndicator status={launcherUpdate} />
          <div className="topbarActions">
            <button className="profileBox" onClick={() => setProfileOpen(true)}>
              <ProfileAvatar user={user} />
              <div>
                <strong>{user.globalName ?? user.username}</strong>
                <small>{savedGameName ? `인게임 · ${savedGameName}` : "인게임 이름 미설정"}</small>
              </div>
            </button>
            <WindowControls />
          </div>
        </header>
        <section className="hero">
          <div className="heroBackdrop" />
          <div className="heroCopy">
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
                <p className="eyebrow">{selected.environment === "test" ? "테스트 서버" : "함께하는 서버"}</p>
                <h2>{selected.name}</h2>
                <p>서버에 맞춰 준비하고 바로 접속해요.</p>
                <div className="chips">
                  <span>Minecraft {selected.minecraftVersion}</span>
                  <span>{serverKindLabel(selected)}</span>
                  <span>{selected.environment === "test" ? "지정 테스터 전용" : "멤버 전용"}</span>
                </div>
              </>
            )}
          </div>
          <div className="actionDock" aria-live="polite">
            {actionToast && <div className="actionToast" role="status">{actionToast}</div>}
            {dockError && !gameBusy && !syncing && (
              <div className="dockError" role="alert">
                <div>
                  <strong>{dockError.title}</strong>
                  <p>{dockError.message}</p>
                </div>
                <div className="dockErrorActions">
                  {dockError.retryWithoutPersonalMods && (
                    <button className="secondaryButton" onClick={() => void launchSelected({ withoutPersonalMods: true })}>개인 모드 빼고 시작</button>
                  )}
                  <button className="secondaryButton" onClick={() => void window.bweeep.openLog("game")}>로그 열기</button>
                  <button className="iconOnly" aria-label="오류 닫기" onClick={dismissDockError}>×</button>
                </div>
              </div>
            )}
            {!dockError && !gameBusy && !syncing && serverState === "offline" && (
              <p className="dockHint">서버 응답 없음 · 접속이 안 될 수 있어요</p>
            )}
            {showLaunchProgress && (
              <div className={`launchProgress${gameRunning && joinedServer ? " isPlaying" : ""}`} role="status">
                <div className="launchProgressHeading">
                  <strong>{progressTitle}</strong>
                  <span>{progressPercent !== null ? `${progressPercent}%` : elapsedSeconds !== null ? formatElapsed(elapsedSeconds) : ""}</span>
                </div>
                {progressDetail && <small title={progressDetail}>{progressDetail}</small>}
                {!(gameRunning && joinedServer) && <progress className="launchProgressBar" max={100} value={progressPercent ?? undefined} />}
              </div>
            )}
            <div className="launchRow">
              <button className="launchButton" disabled={!selected || !canUseLauncher || syncing || gameBusy} aria-busy={showLaunchProgress} onClick={() => void launchSelected()}>
                {gameRunning ? "게임 실행 중" : showLaunchProgress ? <><Spinner />게임 시작 중</> : "게임 시작"}
              </button>
              {gameRunning && gameStatus.pid && (
                <button className="stopButton" onClick={requestStopGame}>게임 종료</button>
              )}
            </div>
          </div>
        </section>
        <section className="serverSummary" aria-label="서버 정보">
          <article className="quickFact">
            <span>인게임 이름</span>
            <strong>{savedGameName || "미설정"}</strong>
            <button className="factLink" onClick={() => setProfileOpen(true)}>변경</button>
          </article>
          <article className="quickFact"><span>Minecraft</span><strong>{selected?.minecraftVersion ?? "-"}</strong></article>
          <article className="quickFact"><span>서버</span><strong>{selected ? serverKindLabel(selected) : "-"}</strong><small>{selected ? selected.environment === "test" ? "테섭" : "본섭" : ""}</small></article>
          <article className="quickFact"><span>클라이언트</span><strong>{selected ? loaderLabel(selected.loader.kind) : "-"}</strong><small>{selected && selected.loader.kind !== "vanilla" ? selected.loader.version : ""}</small></article>
        </section>
      </section>

      {settingsOpen && (
        <div className="modalBackdrop" onClick={() => setSettingsOpen(false)}>
          <section className="modal settingsModal" role="dialog" aria-modal="true" aria-label="런처 설정" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <p className="eyebrow">설정</p>
                <h2>런처 설정</h2>
              </div>
              <button className="closeButton" onClick={() => setSettingsOpen(false)}>닫기</button>
            </header>

            <div className="modalBody">
              {settingsNotice && <p className="noticeBar" role="alert">{settingsNotice}</p>}
              <article className="panel">
                <div className="panelHeader">
                  <h3>서버 선택</h3>
                  <span>본섭과 테섭은 여기에서 바꿔요.</span>
                </div>
                <div className="serverChoiceGrid">
                  {availableServers.map((server) => (
                    <button
                      className={`serverChoice${server.id === selected?.id ? " active" : ""}`}
                      key={server.id}
                      aria-pressed={server.id === selected?.id}
                      onClick={() => selectServer(server.id)}
                      type="button"
                    >
                      <span className={`serverBadge${server.environment === "test" ? " isTest" : ""}`}>{server.environment === "test" ? "테섭" : "본섭"}</span>
                      <strong>{server.name}</strong>
                      <small>Minecraft {server.minecraftVersion} · {serverKindLabel(server)}</small>
                      <small className="serverAddress">{server.server.host}:{server.server.port}</small>
                    </button>
                  ))}
                  {availableServers.length === 0 && <p className="emptyText">{catalogError || "불러오는 중…"}</p>}
                </div>
              </article>

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

              {access.isAdmin && (
                <article className="panel">
                  <div className="panelHeader">
                    <h3>테스터</h3>
                    <span>테스터는 테섭에 들어갈 수 있고, 런처 새 버전을 먼저 받아요.</span>
                  </div>
                  <div className="memberList">
                    {members.length === 0 && <p className="emptyText">불러오는 중…</p>}
                    {members.map((member) => (
                      <div className="memberItem" key={member.userId}>
                        <span>
                          {member.name}
                          {member.gameName ? ` · ${member.gameName}` : ""}
                          {member.role === "admin" ? " · 관리자(항상 테스터)" : ""}
                        </span>
                        {member.role === "admin" ? (
                          <span className="mutedText">테스터</span>
                        ) : (
                          <button className={member.tester ? "secondaryButton" : "textButton"} disabled={testerBusyId !== null} onClick={() => void toggleTester(member)}>
                            {testerBusyId === member.userId ? "저장 중…" : member.tester ? "테스터 해제" : "테스터로 지정"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
              )}

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
            <footer className="modalFooter">
              <button className="textButton" onClick={requestResetSettings}>설정 초기화</button>
              {launcherVersion && <small className="versionText">붸에엡 v{launcherVersion}{launcherChannel === "test" ? " · 테스트 채널" : launcherVersion.includes("-") ? " · 테스트 버전" : ""}</small>}
            </footer>
          </section>
        </div>
      )}

      {profileOpen && (
        <div className="modalBackdrop" onClick={() => setProfileOpen(false)}>
          <section className="modal profileModal" role="dialog" aria-modal="true" aria-label="계정" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div className="profileHeading">
                <ProfileAvatar user={user} />
                <div>
                  <p className="eyebrow">계정</p>
                  <h2>{user.globalName ?? user.username}</h2>
                  <small>Discord로 로그인됨</small>
                </div>
              </div>
              <button className="closeButton" onClick={() => setProfileOpen(false)}>닫기</button>
            </header>
            <div className="modalBody">
              {profileNotice && <p className="noticeBar" role="alert">{profileNotice}</p>}
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
                    </div>
                  ))}
                </div>
                <p className="mutedText">서버와 같은 버전·로더용만 넣어 주세요.</p>
              </section>
            </div>
            <footer className="modalFooter">
              <button className="textButton dangerText" onClick={() => void logout()}>Discord 로그아웃</button>
            </footer>
          </section>
        </div>
      )}

      {modsOpen && selected && (
        <ModsPanel server={selected} instanceRoot={instanceRoot} onClose={() => setModsOpen(false)} />
      )}

      {skinOpen && (
        <Suspense fallback={null}>
          <SkinPanel
            instanceRoot={instanceRoot}
            serverShowsSkins={selected?.gameAuth === "yggdrasil"}
            onClose={() => setSkinOpen(false)}
          />
        </Suspense>
      )}

      {patchNotesOpen && <PatchNotesPanel onClose={() => setPatchNotesOpen(false)} />}

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

function serverStateLabel(state: string): string {
  switch (state) {
    case "online": return "서버 온라인";
    case "offline": return "서버 응답 없음";
    case "catalogError": return "서버 목록 오류";
    case "loading": return "서버 불러오는 중";
    default: return "서버 확인 중";
  }
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

function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "방금 전";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

createRoot(document.getElementById("root")!).render(<App />);
