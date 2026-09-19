import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessStatus,
  CreatedInvite,
  GameStatus,
  LauncherUser,
  LauncherUpdateStatus,
  ServerConnection,
  ServerPreset,
  ServerStatus,
  SyncProgress,
  SyncResult
} from "../shared/types.js";
import "./styles.css";

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
  const [loginPending, setLoginPending] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [result, setResult] = useState<SyncResult | null>(null);
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
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null);
  const [launcherChannel, setLauncherChannel] = useState<"production" | "test">("production");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [testLauncherOpening, setTestLauncherOpening] = useState(false);
  const [gameStatus, setGameStatus] = useState<GameStatus>({ state: "idle" });
  const [gameNameInput, setGameNameInput] = useState("");

  useEffect(() => {
    void Promise.allSettled([
      window.bweeep.listServers(),
      window.bweeep.defaultInstanceRoot(),
      window.bweeep.accessStatus(),
      window.bweeep.serverConnection(),
      window.bweeep.checkLauncherUpdate(),
      window.bweeep.gameStatus(),
      window.bweeep.launcherChannel()
    ]).then(([serverList, root, status, savedConnection, updateStatus, initialGameStatus, channel]) => {
      if (serverList.status === "fulfilled") {
        setServers(serverList.value);
        setSelectedId(serverList.value[0]?.id ?? "");
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
      if (savedConnection.status === "fulfilled") {
        setConnection(savedConnection.value);
        setHostInput(savedConnection.value.host);
        setPortInput(String(savedConnection.value.port));
      }
      if (updateStatus.status === "fulfilled") {
        setLauncherUpdate(updateStatus.value);
        setUpdateOpen(shouldShowUpdate(updateStatus.value));
      }
      if (initialGameStatus.status === "fulfilled") setGameStatus(initialGameStatus.value);
      if (channel.status === "fulfilled") setLauncherChannel(channel.value);
    });
    const unsubscribeProgress = window.bweeep.onProgress((event: SyncProgress) => {
      setLogs((current) => [...current, event]);
      setSyncProgress(event);
    });
    const unsubscribeSession = window.bweeep.onAuthSession((nextUser: LauncherUser) => {
      setLoginPending(false);
      setUser(nextUser);
      void refreshAccessStatus(nextUser);
    });
    const unsubscribeGameStatus = window.bweeep.onGameStatus(setGameStatus);
    const unsubscribeLauncherUpdate = window.bweeep.onLauncherUpdate((status) => {
      setLauncherUpdate(status);
      setUpdateOpen(shouldShowUpdate(status));
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
      unsubscribeLauncherUpdate();
      unsubscribeError();
      unsubscribeInvite();
    };
  }, []);

  const refreshServerStatus = useCallback(async (nextConnection: ServerConnection) => {
    setServerChecking(true);
    try {
      setServerStatus(await window.bweeep.serverStatus(nextConnection));
    } catch {
      setServerStatus({
        online: false,
        host: nextConnection.host,
        port: nextConnection.port,
        message: "서버 상태를 확인할 수 없음"
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
  const progressPercent = syncProgress?.total
    ? Math.round(((syncProgress.completed ?? 0) / syncProgress.total) * 100)
    : 0;

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

  async function saveConnection() {
    setNotice("");
    try {
      const saved = await window.bweeep.saveServerConnection({
        host: hostInput.trim(),
        port: Number(portInput)
      });
      setConnection(saved);
      setHostInput(saved.host);
      setPortInput(String(saved.port));
      setNotice("서버 주소를 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectServer(nextId: string) {
    const next = servers.find((server) => server.id === nextId);
    if (!next) return;
    setSelectedId(nextId);
    setConnection(next.server);
    setHostInput(next.server.host);
    setPortInput(String(next.server.port));
    try {
      await window.bweeep.saveServerConnection(next.server);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "서버 선택을 저장하지 못했습니다.");
    }
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

  async function openPersonalFolder(kind: "mods" | "shaderpacks") {
    try {
      if (!selected) throw new Error("선택한 서버 정보를 찾지 못했습니다.");
      const paths = await window.bweeep.userContentPaths({
        instanceRoot: instanceRoot.trim(),
        minecraftVersion: selected.minecraftVersion,
        loaderKind: selected.loader.kind
      });
      await window.bweeep.openPath(kind === "mods" ? paths.userModsDir : paths.shaderpacksDir);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "내 콘텐츠 폴더를 열지 못했습니다.");
    }
  }

  async function resetSettings() {
    if (!window.confirm("서버 주소와 설치 위치, 화면 로그를 기본값으로 되돌릴까요? 모드팩 파일은 삭제하지 않습니다.")) return;
    try {
      const [saved, root] = await Promise.all([
        window.bweeep.resetServerConnection(),
        window.bweeep.defaultInstanceRoot()
      ]);
      setConnection(saved);
      setHostInput(saved.host);
      setPortInput(String(saved.port));
      setInstanceRoot(root);
      setLogs([]);
      setResult(null);
      setSyncProgress(null);
      setNotice("런처 설정을 기본값으로 되돌렸습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function launchSelected() {
    if (!selected || !instanceRoot.trim() || !canUseLauncher || gameBusy) return;
    setSyncing(true);
    setLogs([]);
    setSyncError("");
    setResult(null);
    setSyncProgress(null);
    try {
      const next = await window.bweeep.launchGame({ packId: selected.packId, instanceDir: instanceRoot.trim() });
      setNotice(`Minecraft를 시작했습니다. (PID ${next.pid})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncError(message);
      setLogs((current) => [...current, { kind: "error", message }]);
      setNotice(message);
    } finally {
      setSyncing(false);
    }
  }

  async function openTestLauncher() {
    setTestLauncherOpening(true);
    setNotice("테스트 런처를 준비하고 있어요.");
    try {
      const result = await window.bweeep.openTestLauncher();
      setNotice(result === "opened" ? "테스트 런처를 열었습니다." : "테스트 런처 설치를 시작했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "테스트 런처를 열지 못했습니다.");
    } finally {
      setTestLauncherOpening(false);
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
          <button className="iconButton" onClick={() => setSettingsOpen(true)}>서버 선택</button>
          <button className="iconButton" onClick={() => setSettingsOpen(true)}>설정</button>
        </nav>
        <div className="supportPanel">
          <div>
            <span className="accessStamp">서버 멤버 전용</span>
            <strong>함께 떠나는 생존 서버</strong>
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
            {launcherChannel === "production" && access.testAllowed && (
              <button
                type="button"
                className="testLauncherInstallButton"
                aria-label="테스트 런처 설치 또는 열기"
                title="테스트 런처 설치 또는 열기"
                disabled={testLauncherOpening}
                onClick={() => void openTestLauncher()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v3h14v-3" />
                </svg>
              </button>
            )}
            <WindowControls />
          </div>
        </header>
        <section className="hero">
          <div className="heroBackdrop" />
          <div className="heroCopy">
            <p className="eyebrow">{selected?.environment === "test" ? "테스트 서버" : "순정 생존 서버"}</p>
            <h2>{selected?.name ?? "서버 없음"}</h2>
            <p>서버에 맞는 Minecraft 버전을 준비하고, 바로 같은 월드로 접속합니다.</p>
            <button className="serverChangeButton" onClick={() => setSettingsOpen(true)}>서버 변경</button>
            <div className="chips">
              <span>Minecraft {selected?.minecraftVersion ?? "-"}</span>
              <span>{selected?.loader.kind === "vanilla" ? "Vanilla" : selected?.loader.kind ?? "-"}</span>
              <span>{selected?.environment === "test" ? "지정 테스터 전용" : "서버 멤버 전용"}</span>
            </div>
          </div>
          <div className="actionDock" aria-live="polite">
            <section className={`updatePanel ${syncing ? "isSyncing" : result ? "isReady" : syncError ? "isError" : ""}`}>
                <div className="updatePanelTop">
                  <span>{syncing ? "업데이트 중" : syncError ? "업데이트 실패" : result ? "준비 완료" : serverStatusMessage}</span>
                  {syncing && <strong>{progressPercent}%</strong>}
                </div>
                <strong className="updateTitle">
                  {syncing
                    ? `${syncProgress?.total ?? 0}개 파일 중 ${syncProgress?.completed ?? 0}개 처리`
                    : syncError ? "업데이트를 완료하지 못했어요"
                    : result ? "같은 버전으로 준비됐어요" : connection ? "전용 서버 연결 준비" : "연결 정보 확인 중"}
                </strong>
                {syncing ? (
                  <>
                    <div className="progressTrack"><i style={{ width: `${progressPercent}%` }} /></div>
                    <p>{syncProgress?.filePath ?? "서버 파일 목록을 확인하는 중"}</p>
                  </>
                ) : syncError ? (
                  <p>{syncError}</p>
                ) : result ? (
                  <p>다운로드 {result?.downloaded ?? 0}개 · 기존 파일 {result?.skipped ?? 0}개 유지</p>
                ) : <p>실행하면 필요한 파일만 자동으로 맞춥니다.</p>}
              </section>
            <button className="launchButton" disabled={!canUseLauncher || syncing || gameBusy} onClick={launchSelected}>
              {gameStatus.state === "running" ? "게임 중" : gameStatus.state === "starting" ? "게임 시작 중" : syncError ? "다시 시도" : "게임 시작"}
            </button>
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

            <section className="panel serverSelectionPanel">
              <div className="panelHeader">
                <div>
                  <h3>서버 선택</h3>
                  <span>선택한 서버에 맞춰 Minecraft와 접속 주소를 준비합니다.</span>
                </div>
                <span className={`serverEnvironment ${selected?.environment === "test" ? "isTest" : ""}`}>
                  {selected?.environment === "test" ? "테스트" : "본 서버"}
                </span>
              </div>
              <label className="serverSelectControl">
                <span>접속할 서버</span>
                <select value={selected?.id ?? ""} onChange={(event) => void selectServer(event.target.value)}>
                  {availableServers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.environment === "test" ? "테스트 서버" : "본 서버"} · {server.name} · Minecraft {server.minecraftVersion}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <div className="settingsGrid">
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
                  {result && <button onClick={() => void window.bweeep.openPath(result.instanceDir)}>폴더 열기</button>}
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
                {result && <span>{result.downloaded} 다운로드 · {result.skipped} 유지</span>}
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
              <span>모드팩 파일과 로그인 계정은 삭제하지 않습니다.</span>
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
                <span>{selected ? `${selected.minecraftVersion} · ${selected.loader.kind} 전용으로 보관됩니다.` : "서버 전환 후에도 유지됩니다."}</span>
              </div>
              <div className="updateActions">
                <button disabled={!instanceRoot.trim()} onClick={() => void openPersonalFolder("mods")}>내 모드 폴더 열기</button>
                <button disabled={!instanceRoot.trim()} onClick={() => void openPersonalFolder("shaderpacks")}>셰이더 폴더 열기</button>
              </div>
              <p className="notice">모드는 .jar, 셰이더는 .zip 파일을 넣으세요. 서버 필수 모드와 파일명이 같으면 내 파일은 적용하지 않습니다.</p>
            </section>
            <section className="panel connectionPanel">
              <div className="panelHeader">
                <h3>서버 연결</h3>
                <span>게임 실행과 상태 확인에 사용됩니다.</span>
              </div>
              <div className="connectionFields">
                <label>주소<input value={hostInput} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setHostInput(event.target.value)} /></label>
                <label>포트<input type="number" min="1" max="65535" value={portInput} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPortInput(event.target.value)} /></label>
              </div>
              <button onClick={() => void saveConnection()}>서버 주소 저장</button>
            </section>
            <footer className="profileFooter">
              <button className="logoutButton" onClick={() => void logout()}>Discord 로그아웃</button>
            </footer>
          </section>
        </div>
      )}

      {updateOpen && launcherUpdate && (
        <div className="modalBackdrop">
          <section className="updateModal" aria-label="런처 업데이트" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">Bweeep update</p>
            <h2>{launcherUpdate.state === "error" ? "업데이트에 실패했어요" : launcherUpdate.state === "available" ? "새 런처 업데이트가 있어요" : "런처를 업데이트하고 있어요"}</h2>
            {launcherUpdate.update && <p className="updateVersion">v{launcherUpdate.update.version}</p>}
            {launcherUpdate.state === "downloading" && (
              <>
                <p>새 버전을 받는 중입니다. 완료되면 런처가 자동으로 재시작됩니다.</p>
                <div className="progressTrack"><i style={{ width: `${launcherUpdate.percent ?? 0}%` }} /></div>
                <small>{launcherUpdate.percent ?? 0}%</small>
              </>
            )}
            {launcherUpdate.state === "available" && <p>여러 버그를 수정하고 안정성을 개선한 새 버전입니다.</p>}
            {launcherUpdate.state === "ready" && <p>{gameBusy ? "게임이 종료되면 업데이트를 설치합니다." : "다운로드를 마쳤습니다. 잠시 후 자동으로 재시작합니다."}</p>}
            {launcherUpdate.state === "installing" && <p>업데이트를 설치하고 다시 시작하는 중입니다.</p>}
            {launcherUpdate.state === "error" && <p>{launcherUpdate.message ?? "자동 업데이트에 실패했습니다."}</p>}
            {launcherUpdate.update && launcherUpdate.update.notes.length > 0 && <ul>{launcherUpdate.update.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
          </section>
        </div>
      )}

    </main>
  );
}

function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase();
}

function shouldShowUpdate(status: LauncherUpdateStatus): boolean {
  return ["downloading", "ready", "installing"].includes(status.state);
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
