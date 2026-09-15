import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessStatus,
  CreatedInvite,
  LauncherUser,
  LoginProvider,
  LauncherUpdateStatus,
  ServerConnection,
  ServerPreset,
  ServerStatus,
  SyncProgress,
  SyncResult
} from "../shared/types.js";
import "./styles.css";

function App() {
  const [servers, setServers] = useState<ServerPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [instanceRoot, setInstanceRoot] = useState("");
  const [logs, setLogs] = useState<SyncProgress[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [user, setUser] = useState<LauncherUser | null>(null);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    void Promise.all([
      window.bweeep.listServers(),
      window.bweeep.defaultInstanceRoot(),
      window.bweeep.accessStatus(),
      window.bweeep.serverConnection(),
      window.bweeep.checkLauncherUpdate(),
      window.bweeep.readyForInvite()
    ]).then(([serverList, root, status, savedConnection, updateStatus, pendingInvite]) => {
      setServers(serverList);
      setSelectedId(serverList[0]?.id ?? "");
      setInstanceRoot(root);
      setAccess(status);
      setUser(status.user ?? null);
      setConnection(savedConnection);
      setHostInput(savedConnection.host);
      setPortInput(String(savedConnection.port));
      setLauncherUpdate(updateStatus);
      setUpdateOpen(updateStatus.state === "available");
      if (pendingInvite) {
        setInviteCode(pendingInvite);
        setSettingsOpen(true);
      }
      if (savedConnection) {
        void window.bweeep.serverStatus(savedConnection).then(setServerStatus).catch(() => {
          setServerStatus({
            online: false,
            host: savedConnection.host,
            port: savedConnection.port,
            message: "서버 상태를 확인할 수 없음"
          });
        });
      }
    });
    const unsubscribeProgress = window.bweeep.onProgress((event: SyncProgress) => {
      setLogs((current) => [...current, event]);
      setSyncProgress(event);
    });
    const unsubscribeSession = window.bweeep.onAuthSession((nextUser: LauncherUser) => {
      setUser(nextUser);
      void window.bweeep.accessStatus().then((status: AccessStatus) => {
        setAccess(status);
        setNotice(status.reason);
      }).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
    });
    const unsubscribeError = window.bweeep.onAuthError(setNotice);
    const unsubscribeInvite = window.bweeep.onInviteCode((code: string) => {
      setInviteCode(code);
      setSettingsOpen(true);
      setNotice("초대 링크를 받았습니다. 로그인 후 코드를 사용해 주세요.");
    });
    return () => {
      unsubscribeProgress();
      unsubscribeSession();
      unsubscribeError();
      unsubscribeInvite();
    };
  }, []);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? servers[0],
    [servers, selectedId]
  );

  const canUseLauncher = Boolean(access?.allowed);
  const progressPercent = syncProgress?.total
    ? Math.round(((syncProgress.completed ?? 0) / syncProgress.total) * 100)
    : 0;

  async function refreshServerStatus(nextConnection: ServerConnection) {
    try {
      setServerStatus(await window.bweeep.serverStatus(nextConnection));
    } catch {
      setServerStatus({
        online: false,
        host: nextConnection.host,
        port: nextConnection.port,
        message: "서버 상태를 확인할 수 없음"
      });
    }
  }

  async function login(provider: LoginProvider) {
    setNotice("");
    try {
      const result = await window.bweeep.login(provider);
      if (!result.configured) {
        setNotice(result.message ?? "로그인 설정이 필요합니다.");
        return;
      }
      if (result.user) {
        setUser(result.user);
        const status = await window.bweeep.accessStatus();
        setAccess(status);
        setNotice(status.reason);
      } else {
        setNotice(result.message ?? "브라우저에서 로그인을 완료해 주세요.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function redeemInvite() {
    setNotice("");
    const result = await window.bweeep.redeemInvite(inviteCode);
    setAccess(result.status);
    setNotice(result.message);
    if (result.ok) setInviteCode("");
  }

  async function createInvite() {
    setNotice("");
    try {
      setCreatedInvite(await window.bweeep.createInvite());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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
      await refreshServerStatus(saved);
      setNotice("서버 주소를 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout() {
    try {
      const status = await window.bweeep.logout();
      setUser(null);
      setAccess(status);
      setCreatedInvite(null);
      setProfileOpen(false);
      setNotice(status.reason);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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
      await refreshServerStatus(saved);
      setNotice("런처 설정을 기본값으로 되돌렸습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function syncSelected() {
    if (!selected || !instanceRoot.trim() || !canUseLauncher) return;
    setSyncing(true);
    setLogs([]);
    setResult(null);
    setSyncProgress(null);
    try {
      const next = await window.bweeep.syncModpack({
        packId: selected.packId,
        instanceDir: instanceRoot.trim()
      });
      setResult(next);
    } catch (error) {
      setLogs((current) => [
        ...current,
        { kind: "error", message: error instanceof Error ? error.message : String(error) }
      ]);
    } finally {
      setSyncing(false);
    }
  }

  async function launchSelected() {
    if (!selected || !instanceRoot.trim() || !canUseLauncher) return;
    setSyncing(true);
    setLogs([]);
    setResult(null);
    setSyncProgress(null);
    try {
      const next = await window.bweeep.launchGame({ packId: selected.packId, instanceDir: instanceRoot.trim() });
      setNotice(`Minecraft를 시작했습니다. (PID ${next.pid})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((current) => [...current, { kind: "error", message }]);
      setNotice(message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark" aria-label="붸에엡">
            <img src="/images/bweeep-pixel-mark-v1.png" alt="" />
          </span>
          <div>
            <p className="eyebrow">modpack launcher</p>
            <h1 className="brandWord">붸에엡</h1>
          </div>
        </div>

        <nav className="iconRail" aria-label="주 메뉴">
          <button className="iconButton active" title="홈">⌂</button>
          <button className="iconButton" title="게임">▣</button>
          <button className="iconButton" title="설정" onClick={() => setSettingsOpen(true)}>⚙</button>
        </nav>

        <section className="supportPanel">
          <div>
            <span className="accessStamp">INVITE ONLY</span>
            <strong>함께 떠나는 모드팩</strong>
            <p>초대 링크로 연결된 친구만 입장할 수 있어요.</p>
          </div>
        </section>

      </aside>

      <section className="content">
        <header className="topbar">
          <div className="searchStub">{connection ? `${connection.host}:${connection.port}` : "서버 확인 중"}</div>
          <div className="topbarActions">
          <button className="settingsButton" onClick={() => setSettingsOpen(true)}>설정</button>
          <button className="profileBox" onClick={() => user ? setProfileOpen(true) : setLoginOpen(true)}>
            {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="avatarFallback">D</span>}
            <div>
              <strong>{user ? user.globalName ?? user.username : "런처 로그인"}</strong>
              <small>{user ? `${user.provider === "microsoft" ? "Microsoft" : "Discord"} · ${access?.allowed ? "허용됨" : "권한 확인 필요"}` : "Discord 또는 Microsoft"}</small>
            </div>
          </button>
          </div>
        </header>

        <section className="hero">
          <div className="heroBackdrop" />
          <div className="heroCopy">
            <p className="eyebrow">Create Aeronautics</p>
            <h2>{selected?.name ?? "서버 없음"}</h2>
            <p>서버에 맞는 모드팩을 검사하고, 다른 파일만 받아서 같은 환경으로 맞춥니다.</p>
            <div className="chips">
              <span>Minecraft 1.21.1</span>
              <span>NeoForge</span>
              <span>초대 전용</span>
            </div>
          </div>
          <div className="actionDock" aria-live="polite">
            {(syncing || result) && (
              <section className={`updatePanel ${syncing ? "isSyncing" : "isReady"}`}>
                <div className="updatePanelTop">
                  <span>{syncing ? "업데이트 중" : "준비 완료"}</span>
                  {syncing && <strong>{progressPercent}%</strong>}
                </div>
                <strong className="updateTitle">
                  {syncing
                    ? `${syncProgress?.total ?? 0}개 파일 중 ${syncProgress?.completed ?? 0}개 처리`
                    : "같은 버전으로 준비됐어요"}
                </strong>
                {syncing ? (
                  <>
                    <div className="progressTrack"><i style={{ width: `${progressPercent}%` }} /></div>
                    <p>{syncProgress?.filePath ?? "서버 파일 목록을 확인하는 중"}</p>
                  </>
                ) : (
                  <p>다운로드 {result?.downloaded ?? 0}개 · 기존 파일 {result?.skipped ?? 0}개 유지</p>
                )}
              </section>
            )}
            <button className="launchButton" disabled={!canUseLauncher || syncing} onClick={launchSelected}>
              {syncing ? "업데이트 중" : canUseLauncher ? "업데이트 후 시작" : "초대 필요"}
            </button>
          </div>
        </section>

        <section className="serverSummary" aria-label="서버 요약">
          <div className="quickFact">
            <span className="factIcon">●</span>
            <span>상태</span>
            <strong>{serverStatus?.message ?? "서버 확인 중"}</strong>
          </div>
          <div className="quickFact">
            <span className="factIcon">↗</span>
            <span>서버</span>
            <strong>{connection ? `${connection.host}:${connection.port}` : "확인 중"}</strong>
          </div>
          <div className="quickFact">
            <span className="factIcon">✦</span>
            <span>모드팩</span>
            <strong>Minecraft 1.21.1 · NeoForge</strong>
          </div>
          <div className="quickFact syncFact">
            <span className="factIcon">↓</span>
            <span>동기화</span>
            <strong>{result ? `${result.downloaded} 다운로드 · ${result.skipped} 유지` : "대기 중"}</strong>
          </div>
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
              <article className="panel accessPanel">
                <div className="panelHeader">
                  <h3>접근 권한</h3>
                  <span>{access?.reason ?? "확인 중"}</span>
                </div>
                <div className="inviteRow">
                  <input
                    value={inviteCode}
                    placeholder="초대 코드"
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setInviteCode(event.target.value)}
                  />
                  <button disabled={!user || !inviteCode.trim()} onClick={redeemInvite}>사용</button>
                </div>
                {access?.allowed && (
                  <div className="adminTools">
                    <button onClick={createInvite}>초대 링크 만들기</button>
                    {createdInvite && <code>bwe-e-ep://invite/{createdInvite.code}</code>}
                  </div>
                )}
                {!user && <div className="loginTools"><button onClick={() => setLoginOpen(true)}>로그인 선택</button></div>}
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
                <p className="eyebrow">{user?.provider === "microsoft" ? "Microsoft account" : "Discord account"}</p>
                <h2>{user?.globalName ?? user?.username ?? "계정"}</h2>
              </div>
              <button className="closeButton" onClick={() => setProfileOpen(false)}>닫기</button>
            </header>
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
              <button className="logoutButton" onClick={() => void logout()}>{user?.provider === "microsoft" ? "Microsoft 로그아웃" : "Discord 로그아웃"}</button>
            </footer>
          </section>
        </div>
      )}

      {updateOpen && launcherUpdate?.update && (
        <div className="modalBackdrop" onClick={() => setUpdateOpen(false)}>
          <section className="updateModal" aria-label="런처 업데이트" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">Bweeep update</p>
            <h2>새 런처 버전이 있어요</h2>
            <p className="updateVersion">v{launcherUpdate.update.version}</p>
            {launcherUpdate.update.notes.length > 0 && <ul>{launcherUpdate.update.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
            <div className="updateActions">
              <button className="launchButton" onClick={() => void window.bweeep.openExternal(launcherUpdate.update!.downloadUrl)}>다운로드</button>
              <button className="closeButton" onClick={() => setUpdateOpen(false)}>나중에</button>
            </div>
          </section>
        </div>
      )}

      {loginOpen && (
        <div className="modalBackdrop" onClick={() => setLoginOpen(false)}>
          <section className="loginModal" aria-label="로그인 선택" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">Choose account</p>
            <h2>어떤 계정으로 참가할까요?</h2>
            <p>초대 권한은 선택한 계정에 연결됩니다.</p>
            <div className="loginChoices">
              <button onClick={() => { setLoginOpen(false); void login("discord"); }}>
                <strong>Discord로 참가</strong>
                <span>Discord 표시명 기반 프로필로 실행</span>
              </button>
              <button onClick={() => { setLoginOpen(false); void login("microsoft"); }}>
                <strong>Microsoft로 참가</strong>
                <span>내 Minecraft Java 닉네임으로 실행</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
