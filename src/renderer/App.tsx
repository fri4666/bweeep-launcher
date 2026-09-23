import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessStatus,
  CreatedInvite,
  GameStatus,
  LauncherUser,
  ServerConnection,
  ServerPreset,
  ServerStatus,
  SyncProgress,
  UserContentFolders,
  UserContentKind
} from "../shared/types.js";
import "./styles.css";

const selectedPackStorageKey = "bweeep.selected-pack-id";

function WindowControls() {
  return (
    <div className="windowControls" aria-label="창 제어">
      <button type="button" aria-label="최소화" onClick={() => window.bweeep.minimizeWindow()}>−</button>
      <button type="button" className="closeWindowButton" aria-label="닫기" onClick={() => window.bweeep.closeWindow()}>×</button>
    </div>
  );
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

function App() {
  const [servers, setServers] = useState<ServerPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverChecking, setServerChecking] = useState(false);
  const [serverCheckedAt, setServerCheckedAt] = useState<number | null>(null);
  const [instanceRoot, setInstanceRoot] = useState("");
  const [logs, setLogs] = useState<SyncProgress[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [lastInstanceDir, setLastInstanceDir] = useState("");
  const [user, setUser] = useState<LauncherUser | null>(null);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [inviteInput, setInviteInput] = useState("");
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [inviteMaxUses, setInviteMaxUses] = useState(10);
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [launcherChannel, setLauncherChannel] = useState<"production" | "test">("production");
  const [launcherVersion, setLauncherVersion] = useState("");
  const [gameStatus, setGameStatus] = useState<GameStatus>({ state: "idle" });
  const [gameNameInput, setGameNameInput] = useState("");
  const [personalFolders, setPersonalFolders] = useState<UserContentFolders>({ mods: [], shaderpacks: [] });
  const [contentAction, setContentAction] = useState<UserContentKind | null>(null);

  function applyServerList(serverList: ServerPreset[]) {
    setServers(serverList);
    const savedId = window.localStorage.getItem(selectedPackStorageKey);
    const initial = serverList.find((server) => server.id === savedId)
      ?? serverList.find((server) => server.default)
      ?? serverList[0];
    setSelectedId(initial?.id ?? "");
    setConnection(initial?.server ?? null);
    setServerStatus(null);
    setServerCheckedAt(null);
  }

  useEffect(() => {
    void Promise.allSettled([
      window.bweeep.listServers(),
      window.bweeep.defaultInstanceRoot(),
      window.bweeep.accessStatus(),
      window.bweeep.gameStatus(),
      window.bweeep.launcherChannel(),
      window.bweeep.launcherVersion()
    ]).then(([serverList, root, status, initialGameStatus, channel, version]) => {
      if (serverList.status === "fulfilled") {
        applyServerList(serverList.value);
      } else {
        applyServerList([]);
        setNotice(serverList.reason instanceof Error ? serverList.reason.message : "서버 목록을 불러오지 못했습니다.");
      }
      if (root.status === "fulfilled") setInstanceRoot(root.value);
      if (status.status === "fulfilled") {
        setAccess(status.value);
        setUser(status.value.user ?? null);
        setGameNameInput(status.value.user?.gameName ?? "");
        if (status.value.unavailable) setNotice(status.value.reason);
      } else {
        setAccess({ loggedIn: false, allowed: false, isAdmin: false, unavailable: true, reason: "로그인 상태를 확인하지 못했습니다." });
        setNotice("로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.");
      }
      if (initialGameStatus.status === "fulfilled") setGameStatus(initialGameStatus.value);
      if (channel.status === "fulfilled") setLauncherChannel(channel.value);
      if (version.status === "fulfilled") setLauncherVersion(version.value);
    });
    const unsubscribeProgress = window.bweeep.onProgress((event: SyncProgress) => {
      setLogs((current) => [...current, event]);
    });
    const unsubscribeSession = window.bweeep.onAuthSession((nextUser: LauncherUser) => {
      setLoginPending(false);
      setUser(nextUser);
      void refreshAccessStatus(nextUser);
      void window.bweeep.listServers().then(applyServerList).catch((error) => {
        applyServerList([]);
        setNotice(error instanceof Error ? error.message : "서버 목록을 불러오지 못했습니다.");
      });
    });
    const unsubscribeGameStatus = window.bweeep.onGameStatus((status) => {
      setGameStatus(status);
      if (status.exitMessage) setNotice(status.exitMessage);
    });
    const unsubscribeError = window.bweeep.onAuthError((message) => {
      setLoginPending(false);
      setNotice(message);
    });
    const acceptInvite = (code: string) => {
      setInviteInput(code);
      setSettingsOpen(true);
      setNotice("초대 링크를 받았습니다. 로그인 후 참여를 눌러 주세요.");
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
      unsubscribeInvite();
    };
  }, []);

  useEffect(() => {
    if (!instanceRoot) return;
    void window.bweeep.userContentFolders(instanceRoot).then(setPersonalFolders).catch((error) => {
      setNotice(error instanceof Error ? error.message : "개인 콘텐츠 폴더를 불러오지 못했습니다.");
    });
  }, [instanceRoot]);

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

  const availableServers = useMemo(
    () => servers.filter((server) => server.environment !== "test" || access?.testAllowed === true),
    [servers, access?.testAllowed]
  );
  const selected = useMemo(
    () => availableServers.find((server) => server.id === selectedId) ?? availableServers[0],
    [availableServers, selectedId]
  );

  const canUseLauncher = Boolean(access?.allowed);
  const gameBusy = gameStatus.state !== "idle";
  const currentProgress = logs[logs.length - 1];
  const showLaunchProgress = syncing || gameStatus.state === "starting";
  const progressPercent = currentProgress?.stage === "모드팩 파일"
    && typeof currentProgress.completed === "number"
    && typeof currentProgress.total === "number"
    && currentProgress.total > 0
      ? Math.round(Math.max(0, Math.min(1, currentProgress.completed / currentProgress.total)) * 100)
      : null;
  const serverStatusMessage = serverChecking ? "서버 연결 확인 중" : serverStatus?.message ?? "서버 확인 중";
  const serverStatusDetail = connection
    ? serverChecking
      ? "실시간 검사 중"
      : serverCheckedAt
        ? serverStatus?.online
          ? `${serverStatus.latencyMs ?? "-"}ms · ${formatRelativeTime(serverCheckedAt)} 확인`
          : ""
        : "검사 대기 중"
    : "연결 정보 확인 중";
  async function refreshAccessStatus(fallbackUser: LauncherUser | null = user) {
    setNotice("");
    try {
      const status = await window.bweeep.accessStatus();
      setAccess(status);
      setUser(status.user ?? fallbackUser);
      setGameNameInput(status.user?.gameName ?? fallbackUser?.gameName ?? "");
      setNotice(status.reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : "접근 권한을 확인하지 못했습니다.";
      setAccess({
        loggedIn: Boolean(fallbackUser),
        allowed: false,
        isAdmin: false,
        unavailable: true,
        reason: message,
        user: fallbackUser ?? undefined
      });
      setNotice(message);
    }
  }

  async function login() {
    if (loginPending) return;
    setNotice("");
    setLoginPending(true);
    try {
      const result = await window.bweeep.login();
      if (!result.configured) {
        setLoginPending(false);
        setNotice(result.message ?? "로그인 설정이 필요합니다.");
        return;
      }
      if (result.user) {
        setLoginPending(false);
        setUser(result.user);
        const status = await window.bweeep.accessStatus();
        setAccess(status);
        setNotice(status.reason);
      } else {
        setNotice(result.message ?? "브라우저에서 로그인을 완료해 주세요.");
      }
    } catch (error) {
      setLoginPending(false);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelLogin() {
    const result = await window.bweeep.cancelLogin();
    if (result.cancelled) setLoginPending(false);
    setNotice(result.message);
  }

  async function redeemInvite() {
    setNotice("");
    try {
      const code = normalizeInviteCode(inviteInput);
      const result = await window.bweeep.redeemInvite(code);
      setAccess(result.status);
      setNotice(result.message);
      if (result.ok) setInviteInput("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "초대 코드를 사용할 수 없습니다.");
    }
  }

  async function createInvite() {
    setNotice("");
    try {
      setCreatedInvite(await window.bweeep.createInvite(inviteMaxUses));
      setInviteCopied(false);
      setInviteLinkCopied(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyInviteCode() {
    if (!createdInvite) return;
    try {
      await window.bweeep.copyText(createdInvite.code);
      setInviteCopied(true);
      setNotice("초대 코드를 복사했습니다.");
    } catch (error) {
      setInviteCopied(false);
      setNotice(error instanceof Error ? error.message : "초대 코드를 복사하지 못했습니다.");
    }
  }

  async function copyInviteLink() {
    if (!createdInvite) return;
    try {
      await window.bweeep.copyText("bwe-e-ep://invite/" + createdInvite.code);
      setInviteLinkCopied(true);
      setNotice("초대 링크를 복사했습니다.");
    } catch (error) {
      setInviteLinkCopied(false);
      setNotice(error instanceof Error ? error.message : "초대 링크를 복사하지 못했습니다.");
    }
  }

  async function selectServer(nextId: string) {
    const next = servers.find((server) => server.id === nextId);
    if (!next) return;
    setSelectedId(nextId);
    window.localStorage.setItem(selectedPackStorageKey, nextId);
    setConnection(next.server);
  }

  async function logout() {
    try {
      const status = await window.bweeep.logout();
      setUser(null);
      setAccess(status);
      setCreatedInvite(null);
      setInviteCopied(false);
      setInviteLinkCopied(false);
      setProfileOpen(false);
      setNotice(status.reason);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveGameProfile() {
    try {
      const saved = await window.bweeep.setGameProfile(gameNameInput.trim());
      setUser(saved);
      setAccess((current) => current ? { ...current, user: saved } : current);
      setGameNameInput(saved.gameName ?? "");
      setNotice("인게임 이름을 저장했습니다. 다음 실행부터 적용됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "인게임 이름을 저장하지 못했습니다.");
    }
  }

  async function choosePersonalFolders(kind: UserContentKind) {
    if (contentAction) return;
    setContentAction(kind);
    try {
      const result = await window.bweeep.chooseUserContentFolders(instanceRoot.trim(), kind);
      setPersonalFolders(result.folders);
      setNotice(result.selected > 0
        ? `${kind === "mods" ? "모드" : "셰이더"} 폴더 ${result.selected}개를 저장했습니다. 다음 게임 실행에 적용됩니다.`
        : "폴더 선택을 취소했거나 이미 추가된 폴더입니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "개인 콘텐츠 폴더를 저장하지 못했습니다.");
    } finally {
      setContentAction(null);
    }
  }

  async function removePersonalFolder(kind: UserContentKind, folder: string) {
    if (contentAction) return;
    setContentAction(kind);
    try {
      const folders = await window.bweeep.removeUserContentFolder(instanceRoot.trim(), kind, folder);
      setPersonalFolders(folders);
      setNotice(`${kind === "mods" ? "모드" : "셰이더"} 폴더를 저장 목록에서 뺐습니다. 다음 게임 실행부터 적용하지 않습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "개인 콘텐츠 폴더를 저장하지 못했습니다.");
    } finally {
      setContentAction(null);
    }
  }

  async function resetSettings() {
    if (!window.confirm("서버 주소와 설치 위치, 화면 로그를 기본값으로 되돌릴까요? 모드팩 파일은 삭제하지 않습니다.")) return;
    try {
      const root = await window.bweeep.defaultInstanceRoot();
      window.localStorage.removeItem(selectedPackStorageKey);
      const initial = servers.find((server) => server.default) ?? servers[0];
      setSelectedId(initial?.id ?? "");
      if (initial) setConnection(initial.server);
      setInstanceRoot(root);
      setLogs([]);
      setLastInstanceDir("");
      setNotice("런처 설정을 기본값으로 되돌렸습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function launchSelected() {
    if (!selected || !instanceRoot.trim() || !canUseLauncher || gameBusy) return;
    setSyncing(true);
    setLogs([]);
    setNotice("");
    setLaunchError("");
    setLastInstanceDir("");
    try {
      const next = await window.bweeep.launchGame({ packId: selected.packId, instanceDir: instanceRoot.trim() });
      setLastInstanceDir(next.instanceDir);
      const currentStatus = await window.bweeep.gameStatus();
      setGameStatus(currentStatus);
      if (currentStatus.state === "idle") {
        const message = currentStatus.exitMessage ?? "Minecraft가 실행 직후 종료되었습니다. 게임 폴더의 logs/latest.log를 확인하세요.";
        setLaunchError(message);
        setNotice(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((current) => [...current, { kind: "error", message }]);
      setLaunchError(message);
      setNotice(message);
    } finally {
      setSyncing(false);
    }
  }

  if (!access) {
    return (
      <main className="entryScreen">
        <WindowControls />
        <section className="entryCard isLoading">
          <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
          <p className="eyebrow">Bweeep launcher</p>
          <h1>런처를 준비하고 있어요</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="entryScreen">
        <WindowControls />
        <section className="entryCard">
          <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
          <p className="eyebrow">Bweeep launcher</p>
          <h1>로그인하고 시작하세요</h1>
          <p className="entryDescription">친구 전용 생존 서버는 로그인 후에 표시됩니다.</p>
          <div className="entryChoices">
            <button disabled={loginPending} onClick={() => void login()}>
              <strong>{loginPending ? "Discord 로그인 진행 중" : "Discord로 로그인"}</strong>
              <span>{loginPending ? "브라우저에서 인증을 완료해 주세요" : "Discord 프로필로 참가"}</span>
            </button>
          </div>
          {loginPending && <button className="cancelLoginButton" onClick={() => void cancelLogin()}>로그인 취소</button>}
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
    );
  }

  if (access.unavailable) {
    return (
      <main className="entryScreen">
        <WindowControls />
        <section className="entryCard">
          <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
          <p className="eyebrow">Connection check</p>
          <h1>권한 확인에 실패했어요</h1>
          <p className="entryDescription">{access.reason}</p>
          <div className="entryRecovery">
            <button onClick={() => void refreshAccessStatus(user)}>다시 확인</button>
            <button className="entryLogout" onClick={() => void logout()}>다른 계정으로 로그인</button>
          </div>
        </section>
      </main>
    );
  }

  if (!access.allowed) {
    return (
      <main className="entryScreen">
        <WindowControls />
        <section className="entryCard">
          <img src="./images/bweeep-pixel-mark-v1.png" alt="" />
          <p className="eyebrow">멤버 전용</p>
          <h1>초대 코드를 입력하세요</h1>
          <p className="entryDescription">{access.reason}</p>
          <div className="entryInvite">
            <input value={inviteInput} placeholder="초대 코드" onChange={(event) => setInviteInput(event.target.value)} />
            <button disabled={!inviteInput.trim()} onClick={() => void redeemInvite()}>참여</button>
          </div>
          <p className="inviteHint">친구에게 받은 BWEEP 초대 코드를 붙여 넣으세요.</p>
          <button className="entryLogout" onClick={() => void logout()}>다른 계정으로 로그인</button>
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
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

        <nav className="iconRail" aria-label="주 메뉴">
          <button className="iconButton active">홈</button>
          <button className="iconButton" onClick={() => setProfileOpen(true)}>계정</button>
          <button className="iconButton" onClick={() => setSettingsOpen(true)}>설정</button>
        </nav>
        <div className="supportPanel">
          <div>
            <span className="accessStamp">서버 멤버 전용</span>
            <strong>함께하는 모드팩 서버</strong>
            <p>초대받은 친구들과 같은 Minecraft 버전으로 바로 시작할 수 있어요.</p>
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="searchStub">
            <span className={`statusDot ${serverChecking ? "checking" : serverStatus?.online ? "online" : ""}`} />
            <div><strong>{serverStatusMessage}</strong><small>{serverStatusDetail}</small></div>
          </div>
          <div className="topbarActions">
            <button className="profileBox" onClick={() => setProfileOpen(true)}>
              <ProfileAvatar user={user} />
              <div><strong>{user.globalName ?? user.username}</strong><small>Discord</small></div>
            </button>
            <WindowControls />
          </div>
        </header>
        <section className="hero">
          <div className="heroBackdrop" />
          <div className="heroCopy">
            <p className="eyebrow">전용 서버</p>
            <h2>{selected?.name ?? "서버 없음"}</h2>
            <p>서버에 맞는 Minecraft 버전을 준비하고, 바로 같은 월드로 접속합니다.</p>
            {!selected && <p className="notice">{notice || "서버 목록을 불러오지 못했습니다."}</p>}
            <div className="chips">
              <span>Minecraft {selected?.minecraftVersion ?? "-"}</span>
              <span>{selected?.loader.kind === "vanilla" ? "Vanilla" : selected?.loader.kind ?? "-"}</span>
              <span>{selected?.environment === "test" ? "지정 테스터 전용" : "서버 멤버 전용"}</span>
            </div>
          </div>
          <div className="actionDock" aria-live="polite">
            {showLaunchProgress && (
              <div className="launchProgress" role="status">
                <div className="launchProgressHeading">
                  <strong>{currentProgress?.stage ?? "게임 시작 준비"}</strong>
                  {progressPercent !== null && <span>{progressPercent}%</span>}
                </div>
                <progress className="launchProgressBar" max={100} value={progressPercent ?? undefined} />
                <small>{currentProgress?.message ?? "서버 정보를 확인하는 중"}</small>
              </div>
            )}
            <button className="launchButton" disabled={!selected || !canUseLauncher || syncing || gameBusy} aria-busy={gameBusy} onClick={launchSelected}>
              {gameStatus.state === "running" ? "게임 중" : showLaunchProgress ? "게임 시작 중" : "게임 시작"}
            </button>
            {(gameStatus.exitMessage || launchError) && <p className={`launchNotice${gameStatus.exitError || launchError ? " isError" : ""}`}>{gameStatus.exitMessage || launchError}</p>}
          </div>
        </section>
        <section className="serverSummary" aria-label="서버 정보">
          <article className="quickFact"><span className="factIcon">●</span><span>서버 상태</span><strong>{serverStatusMessage}</strong><small>{serverCheckedAt && !serverChecking && serverStatus?.online ? `${serverStatus.latencyMs ?? "-"}ms · ${formatRelativeTime(serverCheckedAt)}` : serverStatus?.online ? "실시간 확인" : ""}</small></article>
          <article className="quickFact"><span className="factIcon">◆</span><span>게임</span><strong>{selected?.name ?? "없음"}</strong></article>
          <article className="quickFact"><span className="factIcon">▰</span><span>Minecraft</span><strong>{selected?.minecraftVersion ?? "-"}</strong></article>
          <article className="quickFact"><span className="factIcon">◈</span><span>실행 방식</span><strong>{selected?.loader.kind === "vanilla" ? "Vanilla" : selected ? `${selected.loader.kind} ${selected.loader.version}` : "-"}</strong></article>
        </section>
      </section>

      {settingsOpen && (
        <div className="modalBackdrop" onClick={() => setSettingsOpen(false)}>
          <section className="settingsModal" aria-label="설정" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>런처 설정</h2>
              </div>
              <button className="closeButton" onClick={() => setSettingsOpen(false)}>닫기</button>
            </header>

            <div className="settingsGrid">
              <article className="panel serverSelectPanel">
                <div className="panelHeader">
                  <h3>서버 선택</h3>
                  <span>본섭과 테섭 전환은 여기에서만 바꿉니다.</span>
                </div>
                <div className="serverChoiceGrid">
                  {availableServers.map((server) => (
                    <button
                      className={`serverChoice ${server.id === selected?.id ? "active" : ""}`}
                      key={server.id}
                      onClick={() => void selectServer(server.id)}
                      type="button"
                    >
                      <span>{server.environment === "test" ? "테섭" : "본섭"}</span>
                      <strong>{server.name}</strong>
                      <small>Minecraft {server.minecraftVersion} · {server.loader.kind === "vanilla" ? "Vanilla" : `${server.loader.kind} ${server.loader.version}`}</small>
                    </button>
                  ))}
                </div>
              </article>

              <article className="panel connectionPanel">
                <div className="panelHeader">
                  <h3>서버 연결</h3>
                <span>선택한 프리셋의 서버로 자동 연결합니다.</span>
              </div>
              <p className="connectionSummary">{selected ? `${selected.server.host}:${selected.server.port}` : "서버를 선택해 주세요."}</p>
              </article>

              <article className="panel accessPanel">
                <div className="panelHeader">
                  <h3>접근 권한</h3>
                  <span>{access?.reason ?? "확인 중"}</span>
                </div>
                <div className="inviteRow">
                  <input value={inviteInput} placeholder="초대 코드" onChange={(event) => setInviteInput(event.target.value)} />
                  <button disabled={!user || !inviteInput.trim()} onClick={() => void redeemInvite()}>참여</button>
                </div>
                {access?.allowed && (
                  <div className="adminTools">
                    <div className="inviteCreateRow">
                      <label>
                        사용 인원
                        <select value={inviteMaxUses} onChange={(event) => setInviteMaxUses(Number(event.target.value))}>
                          <option value={1}>1명</option>
                          <option value={5}>5명</option>
                          <option value={10}>10명</option>
                          <option value={20}>20명</option>
                        </select>
                      </label>
                      <button onClick={() => void createInvite()}>{inviteMaxUses}명용 초대 만들기</button>
                    </div>
                    {createdInvite && (
                      <div className="createdInvite">
                        <code>{createdInvite.code}</code>
                        <button onClick={() => void copyInviteCode()}>{inviteCopied ? "복사됨" : "코드 복사"}</button>
                        <button onClick={() => void copyInviteLink()}>{inviteLinkCopied ? "링크 복사됨" : "링크 복사"}</button>
                        <small>{createdInvite.maxUses}명까지 · {new Date(createdInvite.expiresAt).toLocaleDateString("ko-KR")} 만료</small>
                      </div>
                    )}
                  </div>
                )}
                {notice && <p className="notice">{notice}</p>}
              </article>

              <article className="panel installPanel">
                <div className="panelHeader">
                  <h3>설치 위치</h3>
                  {lastInstanceDir && <button onClick={() => void window.bweeep.openPath(lastInstanceDir)}>폴더 열기</button>}
                </div>
                <input
                  value={instanceRoot}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => setInstanceRoot(event.target.value)}
                />
              </article>
            </div>

            <section className="panel logPanel">
              <div className="panelHeader">
                <h3>설치 로그</h3>
              </div>
              <div className="log">
                {logs.length === 0 ? (
                  <p className="empty">권한 확인 후 업데이트를 시작할 수 있습니다.</p>
                ) : (
                  logs.map((entry, index) => (
                    <p className={`logLine ${entry.kind}`} key={`${entry.kind}-${index}`}>
                      {entry.message}
                    </p>
                  ))
                )}
              </div>
            </section>
            <footer className="settingsFooter">
              <button className="resetButton" onClick={() => void resetSettings()}>설정 초기화</button>
              <div className="settingsFooterInfo">
                <span>모드팩 파일과 로그인 계정은 삭제하지 않습니다.</span>
                {launcherVersion && <small>붸에엡 v{launcherVersion}{launcherChannel === "test" ? " · 테스트" : ""}</small>}
              </div>
            </footer>
          </section>
        </div>
      )}

      {profileOpen && (
        <div className="modalBackdrop" onClick={() => setProfileOpen(false)}>
          <section className="profileModal" aria-label="계정 및 서버 설정" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <p className="eyebrow">Discord 계정</p>
                <h2>{user?.globalName ?? user?.username ?? "계정"}</h2>
              </div>
              <button className="closeButton" onClick={() => setProfileOpen(false)}>닫기</button>
            </header>
            <section className="panel connectionPanel">
              <div className="panelHeader">
                <h3>인게임 프로필</h3>
                <span>Discord 계정에 연결되어 모든 서버에서 사용됩니다.</span>
              </div>
              <div className="connectionFields">
                <label>인게임 이름<input maxLength={16} value={gameNameInput} placeholder="영문·숫자·밑줄 3~16자" onChange={(event: React.ChangeEvent<HTMLInputElement>) => setGameNameInput(event.target.value)} /></label>
              </div>
              <button disabled={!/^[A-Za-z0-9_]{3,16}$/.test(gameNameInput.trim())} onClick={() => void saveGameProfile()}>인게임 이름 저장</button>
            </section>
            <section className="panel connectionPanel">
              <div className="panelHeader">
                <h3>내 모드와 셰이더</h3>
                <span>선택한 폴더를 모두 저장해 서버 전환 뒤에도 적용합니다.</span>
              </div>
              <div className="contentFolderGroups">
                {(["mods", "shaderpacks"] as const).map((kind) => (
                  <div className="contentFolderGroup" key={kind}>
                    <div className="contentFolderLabel">
                      <strong>{kind === "mods" ? "모드 폴더" : "셰이더 폴더"}</strong>
                      <span>{kind === "mods" ? ".jar" : ".zip"} 파일 · 여러 폴더 가능</span>
                    </div>
                    <div className="contentFolderList">
                      {personalFolders[kind].length === 0 ? <p>선택한 폴더가 없습니다.</p> : personalFolders[kind].map((folder) => (
                        <div className="contentFolderItem" key={folder} title={folder}>
                          <span>{folder}</span>
                          <button aria-label={`${kind === "mods" ? "모드" : "셰이더"} 폴더 제거`} disabled={contentAction !== null} onClick={() => void removePersonalFolder(kind, folder)}>×</button>
                        </div>
                      ))}
                    </div>
                    <button className="contentFolderAdd" disabled={!instanceRoot.trim() || contentAction !== null} onClick={() => void choosePersonalFolders(kind)}>
                      {contentAction === kind ? "저장 중…" : `${kind === "mods" ? "모드" : "셰이더"} 폴더 선택`}
                    </button>
                  </div>
                ))}
              </div>
              <p className="notice">같은 이름의 파일도 서로 다른 선택 폴더에 있으면 함께 적용합니다. 현재 Minecraft 버전과 로더에 맞는 파일만 사용하세요.</p>
            </section>
            <footer className="profileFooter">
              <button className="logoutButton" onClick={() => void logout()}>Discord 로그아웃</button>
            </footer>
          </section>
        </div>
      )}

    </main>
  );
}

function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase();
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
