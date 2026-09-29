import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
const signedIn = process.env.BWEEP_PREVIEW_SIGNED_IN !== "false";
const accessUnavailable = process.env.BWEEP_PREVIEW_ACCESS_UNAVAILABLE === "true";
const accessDenied = process.env.BWEEP_PREVIEW_ACCESS_DENIED === "true";
const catalogUnavailable = process.env.BWEEP_PREVIEW_CATALOG_UNAVAILABLE === "true";
const testChannelDenied = process.env.BWEEP_PREVIEW_TEST_CHANNEL_DENIED === "true";
const whatsNewMode = process.env.BWEEP_PREVIEW_WHATS_NEW === "true";
const patchNotesOffline = process.env.BWEEP_PREVIEW_PATCH_NOTES_OFFLINE === "true";
const serverOffline = process.env.BWEEP_PREVIEW_SERVER_OFFLINE === "true";
const authOutage = process.env.BWEEP_PREVIEW_AUTH_OUTAGE === "true";
const moveAndModsMode = process.env.BWEEP_PREVIEW_MOVE_AND_MODS === "true";
const adminMode = process.env.BWEEP_PREVIEW_ADMIN === "true";
const memberMode = process.env.BWEEP_PREVIEW_MEMBER === "true";
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({ previewSignedIn, previewAccessUnavailable, previewAccessDenied, previewCatalogUnavailable, previewTestChannelDenied, previewWhatsNew, previewPatchNotesOffline, previewServerOffline, previewAuthOutage, previewMoveAndMods, previewMember }) => {
  // A minimized window reports "hidden"; previews switch it with window.__setHidden.
  window.__hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__hidden ? "hidden" : "visible" });
  window.__setHidden = (hidden) => {
    window.__hidden = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  window.__launchRequests = 0;
  const listeners = [];
  const gameStatusListeners = [];
  const updateListeners = [];
  const authFailureListeners = [];
  window.__emitUpdate = (status) => updateListeners.forEach((listener) => listener(status));
  window.__authFailure = (reason) => authFailureListeners.forEach((listener) => listener({ reason, at: new Date().toISOString() }));
  window.__diagnosticsSent = 0;
  window.__openedDiagnostics = null;
  const hoursFromNow = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
  let adminNames = {
    holds: [
      { userId: "00000000-0000-0000-0000-000000000002", owner: "나원", gameName: "nawon_old", kind: "released", heldUntil: hoursFromNow(17) },
      { userId: "00000000-0000-0000-0000-000000000003", owner: "떠난친구", gameName: "creeper_bye", kind: "removed", heldUntil: hoursFromNow(3) }
    ],
    reservations: [
      { minecraftUuid: "32068d51-3b1c-3a2e-9c1f-6c8b2f9d0a11", gameName: "creeperppangchae", userId: "00000000-0000-0000-0000-000000000002", owner: "나원", source: "vanilla usercache", createdAt: "2026-09-28T13:00:00Z" },
      { minecraftUuid: "5f1e2d3c-4b5a-3968-8776-a5b4c3d2e1f0", gameName: "PSH_1227", userId: null, owner: null, source: "vanilla usercache", createdAt: "2026-09-28T13:00:00Z" }
    ]
  };
  let adminReleases = [
    { id: "10000000-0000-0000-0000-000000000003", packId: "vanilla-survival", name: "Vanilla Survival", version: "2026.09.28", active: true, gameAuth: "yggdrasil", audience: "members", createdAt: "2026-09-28T13:07:00Z" },
    { id: "10000000-0000-0000-0000-000000000002", packId: "vanilla-survival", name: "Vanilla Survival", version: "2026.09.20", active: false, gameAuth: "offline", audience: "members", createdAt: "2026-09-20T09:00:00Z" },
    { id: "10000000-0000-0000-0000-000000000004", packId: "society-sunlit-valley", name: "Sunlit Valley", version: "4.1.5-2026.09.29", active: false, gameAuth: "yggdrasil", audience: "members", createdAt: "2026-09-29T02:00:00Z" },
    { id: "10000000-0000-0000-0000-000000000005", packId: "society-sunlit-valley", name: "Sunlit Valley", version: "4.1.5-2026.09.28", active: true, gameAuth: "yggdrasil", audience: "members", createdAt: "2026-09-28T13:10:00Z" }
  ];
  const adminDiagnostics = {
    failures: [
      { id: "1", userId: "00000000-0000-0000-0000-000000000002", owner: "나원", gameName: "nawon", audience: "members", reason: "token_expired", at: hoursFromNow(-2) },
      { id: "2", userId: null, owner: null, gameName: "seos_py", audience: "members", reason: "no_join", at: hoursFromNow(-30) },
      { id: "3", userId: "00000000-0000-0000-0000-000000000002", owner: "나원", gameName: "nawon", audience: "testers", reason: "testers_only", at: hoursFromNow(-50) }
    ],
    uploads: [
      { id: "20000000-0000-0000-0000-000000000001", userId: "00000000-0000-0000-0000-000000000002", owner: "나원", sizeBytes: 187_000, at: hoursFromNow(-1) }
    ]
  };
  let gameStatus = { state: "idle" };
  const emitGameStatus = (status) => {
    gameStatus = status;
    gameStatusListeners.forEach((listener) => listener(status));
  };
  window.__exitGame = () => emitGameStatus({ state: "idle", exitMessage: "Minecraft가 종료되었습니다.", exitError: false });
  window.__failGame = () => emitGameStatus({ state: "idle", exitMessage: "Minecraft가 비정상 종료되었습니다. (신호 SIGSEGV)", exitError: true });
  window.__failWithPersonalMods = () => emitGameStatus({ state: "idle", exitMessage: "Minecraft가 비정상 종료되었습니다. (코드 1)", exitError: true, retryWithoutPersonalMods: "create-aeronautics" });
  window.__rejectGame = () => {
    listeners.forEach((listener) => listener({ kind: "error", stage: "서버 접속 실패", message: "선택 서버가 연결을 거절했습니다." }));
    emitGameStatus({ state: "idle", exitMessage: "Minecraft가 종료되었습니다.", exitError: false });
  };
  window.__exitBeforeLaunchResolves = false;
  window.__zeroFileSync = false;
  window.__copiedText = null;
  window.__serverStatusCalls = 0;
  window.__stopRequests = 0;
  let inviteRedeemed = false;
  let invites = [];
  // Flat-colour 64x64 skins drawn on demand, so previews need no image files.
  const skinDataUrl = (body, head = "#e8c050") => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    context.fillStyle = head; context.fillRect(0, 0, 32, 16);
    context.fillStyle = body; context.fillRect(0, 16, 56, 16); context.fillRect(16, 48, 32, 16);
    return canvas.toDataURL("image/png");
  };
  let skinState = null;
  const skins = () => {
    skinState ??= {
      current: { id: "a".repeat(64), model: "slim", dataUrl: skinDataUrl("#c43c3c") },
      library: [
        { id: "a".repeat(64), name: "빨간 모험가", model: "slim", dataUrl: skinDataUrl("#c43c3c"), addedAt: "2026-09-28T00:00:00Z" },
        { id: "b".repeat(64), name: "보라 기사", model: "default", dataUrl: skinDataUrl("#8c3cc8"), addedAt: "2026-09-27T00:00:00Z" }
      ],
      defaults: [
        { name: "Steve", model: "default", dataUrl: skinDataUrl("#3c9ca0", "#b07850") },
        { name: "Alex", model: "slim", dataUrl: skinDataUrl("#50a050", "#e0a070") }
      ]
    };
    return skinState;
  };
  let members = [
    { userId: "1", name: "붸에엡", gameName: "seos_py", role: "admin", tester: true, lastPlayedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    { userId: "00000000-0000-0000-0000-000000000002", name: "나원", gameName: null, role: "member", tester: false, lastPlayedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    { userId: "00000000-0000-0000-0000-000000000004", name: "집가고싶다", gameName: "PSH_1227", role: "member", tester: true, lastPlayedAt: null }
  ];
  // Mods installed for the server's previous version, waiting to be fetched again.
  let personalMods = previewMoveAndMods ? [
    { projectId: "AANobbMI", title: "Sodium", versionNumber: "mc1.20.6-0.5.11", fileName: "sodium.jar", explicit: true, previousTarget: "NeoForge 1.20.6" },
    { projectId: "gvQqBUqZ", title: "Lithium", versionNumber: "mc1.20.6-0.12.7", fileName: "lithium.jar", explicit: true, previousTarget: "NeoForge 1.20.6" },
    { projectId: "8shC1gFX", title: "Better F3", versionNumber: "7.0.2", fileName: "betterf3.jar", explicit: true, previousTarget: "NeoForge 1.20.6", unavailable: "맞는 버전 없음" }
  ] : [];
  const moveListeners = [];
  window.__releaseMove = null;
  const modHits = [
    { projectId: "AANobbMI", slug: "sodium", title: "Sodium", description: "렌더링을 크게 빠르게 해 주는 최적화 모드", iconUrl: null, downloads: 71000000, status: "available" },
    { projectId: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", description: "Fabric 모드용 공통 라이브러리", iconUrl: null, downloads: 110000000, status: "inPack" },
    { projectId: "zbhsCnsA", slug: "xaeros-minimap", title: "Xaero's Minimap", description: "화면 구석에 미니맵을 보여 줘요", iconUrl: null, downloads: 30000000, status: "blocked" }
  ];
  const result = {
    manifest: {
      schemaVersion: 1,
      id: "create-aeronautics",
      name: "Create Aeronautics",
      version: "2026.09.14",
      minecraftVersion: "1.21.1",
      loader: { kind: "neoforge", version: "21.1.228" },
      server: { host: "server.fri4666.com", port: 25565 },
      files: []
    },
    instanceDir: "C:\\Bweeep\\instances\\create-aeronautics",
    downloaded: 2,
    skipped: 1
  };

  window.bweeep = {
    listServers: async () => {
      if (previewCatalogUnavailable) throw new Error("서버 목록 연결 실패");
      return [
        {
          id: "create-aeronautics",
          name: "Create Aeronautics",
          packId: "create-aeronautics",
          description: "하늘과 기계가 만나는 모드팩",
          environment: "production",
          server: { host: "server.fri4666.com", port: 25565 },
          minecraftVersion: "1.21.1",
          loader: { kind: "neoforge", version: "21.1.228" },
          serverLoader: { kind: "fabric", version: "0.18.1" },
          gameAuth: "yggdrasil",
          blockedModrinthProjects: ["zbhsCnsA"],
          recommendedMemoryMb: 6144
        },
        {
          id: "vanilla-survival-test",
          name: "Vanilla Test",
          packId: "vanilla-survival-test",
          description: "테스터 검증용 순정 서버",
          environment: "test",
          server: { host: "server.fri4666.com", port: 25566 },
          minecraftVersion: "26.3",
          loader: { kind: "fabric", version: "0.19.5" },
          gameAuth: "offline",
          blockedModrinthProjects: [],
          recommendedMemoryMb: 3072
        }
      ];
    },
    systemMemory: async () => ({ totalMb: 16384 }),
    listMembers: async () => members,
    setTester: async (userId, tester) => {
      members = members.map((member) => member.userId === userId ? { ...member, tester } : member);
      return members;
    },
    setMemberRole: async (userId, role) => {
      members = members.map((member) => member.userId === userId ? { ...member, role, tester: role === "admin" || member.tester } : member);
      return members;
    },
    removeMember: async (userId) => {
      members = members.filter((member) => member.userId !== userId);
      return members;
    },
    adminNames: async () => adminNames,
    releaseName: async (userId, gameName) => {
      adminNames = { ...adminNames, holds: adminNames.holds.filter((hold) => hold.userId !== userId || hold.gameName !== gameName) };
      return adminNames;
    },
    deleteReservation: async (uuid) => {
      adminNames = { ...adminNames, reservations: adminNames.reservations.filter((item) => item.minecraftUuid !== uuid) };
      return adminNames;
    },
    adminReleases: async () => adminReleases,
    activateRelease: async (releaseId) => {
      const target = adminReleases.find((release) => release.id === releaseId);
      adminReleases = adminReleases.map((release) => release.packId === target.packId ? { ...release, active: release.id === releaseId } : release);
      return adminReleases;
    },
    adminDiagnostics: async () => adminDiagnostics,
    openDiagnostics: async (id) => { window.__openedDiagnostics = id; },
    sendDiagnostics: async () => {
      window.__diagnosticsSent += 1;
      if (window.__diagnosticsSent > 1) throw new Error("Error invoking remote method 'diagnostics:send': Error: 진단 정보는 10분에 한 번만 보낼 수 있어요.");
    },
    onAuthFailure: (listener) => {
      authFailureListeners.push(listener);
      return () => {
        const index = authFailureListeners.indexOf(listener);
        if (index >= 0) authFailureListeners.splice(index, 1);
      };
    },
    skinState: async () => skins(),
    addSkin: async () => {
      const state = skins();
      state.library = [{ id: "c".repeat(64), name: "새로 넣은 스킨", model: "default", dataUrl: skinDataUrl("#3c78c8"), addedAt: "2026-09-28T01:00:00Z" }, ...state.library];
      return state;
    },
    applySkin: async (_root, id, model) => {
      const state = skins();
      const entry = state.library.find((item) => item.id === id);
      state.current = { id, model, dataUrl: entry.dataUrl };
      return state;
    },
    applyDefaultSkin: async (_root, name) => {
      const state = skins();
      const skin = state.defaults.find((item) => item.name === name);
      state.current = { id: "d".repeat(64), model: skin.model, dataUrl: skin.dataUrl };
      return state;
    },
    setSkinModel: async () => skins(),
    removeSkin: async (_root, id) => {
      const state = skins();
      state.library = state.library.filter((item) => item.id !== id);
      return state;
    },
    resetSkin: async () => {
      const state = skins();
      state.current = null;
      return state;
    },
    searchMods: async (_target, query) => /pack|팩/i.test(query)
      ? { hits: [], total: 0, modpacks: ["Fabulously Optimized"] }
      : { hits: modHits, total: modHits.length, modpacks: [] },
    personalMods: async () => personalMods,
    installMod: async (_target, projectId) => {
      const hit = modHits.find((item) => item.projectId === projectId);
      personalMods = [...personalMods, { projectId, title: hit.title, versionNumber: "0.6.13", fileName: `${hit.slug}.jar`, explicit: true }];
      return personalMods;
    },
    updateMod: async () => personalMods,
    removeMod: async (_target, projectId) => {
      personalMods = personalMods.filter((mod) => mod.projectId !== projectId);
      return personalMods;
    },
    refetchMods: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      personalMods = personalMods.map((mod) => mod.previousTarget && !mod.unavailable
        ? { projectId: mod.projectId, title: mod.title, versionNumber: "mc1.21.1-0.6.13", fileName: mod.fileName, explicit: true }
        : mod);
      return personalMods;
    },
    checkInstallMove: async (_from, to) => to.includes("instances")
      ? { entries: 3, bytes: 3_650_000_000, problem: "지금 위치와 겹치는 폴더예요" }
      : { entries: 3, bytes: 3_650_000_000 },
    moveInstall: async () => {
      for (const percent of [0, 12, 37]) moveListeners.forEach((listener) => listener(percent));
      await new Promise((resolve) => { window.__releaseMove = resolve; });
      for (const percent of [80, 100]) moveListeners.forEach((listener) => listener(percent));
      return "move-1";
    },
    finishInstallMove: async (moveId) => { window.__finishedMove = moveId; },
    onInstallMoveProgress: (listener) => {
      moveListeners.push(listener);
      return () => {
        const index = moveListeners.indexOf(listener);
        if (index >= 0) moveListeners.splice(index, 1);
      };
    },
    discordPresence: async () => ({ available: true, enabled: window.__discordEnabled ?? true }),
    setDiscordPresence: async (enabled) => {
      window.__discordEnabled = enabled;
      return { available: true, enabled };
    },
    defaultInstanceRoot: async () => "C:\\Bweeep\\instances",
    userContentFolders: async () => ({ mods: ["D:\\Minecraft\\my-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders"] }),
    chooseUserContentFolders: async (_root, kind) => ({ folders: kind === "mods" ? { mods: ["D:\\Minecraft\\my-mods", "D:\\Minecraft\\more-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders"] } : { mods: ["D:\\Minecraft\\my-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders", "D:\\Minecraft\\more-shaders"] }, selected: 1 }),
    removeUserContentFolder: async (_root, kind, folder) => ({ mods: kind === "mods" ? [] : ["D:\\Minecraft\\my-mods"], shaderpacks: kind === "shaderpacks" ? [] : ["D:\\Minecraft\\my-shaders"] }),
    // The test server (25566) is off; the main one too in the server-offline preview.
    serverStatus: async (server) => {
      window.__serverStatusCalls += 1;
      if (server.port === 25566 || (previewServerOffline && !window.__serverBackOnline)) {
        return { online: false, host: server.host, port: server.port, message: "연결 끊김" };
      }
      return {
        online: true,
        host: server.host,
        port: server.port,
        latencyMs: 18,
        message: "서버 연결 가능",
        players: { online: 3, max: 20 },
        version: "1.21.1"
      };
    },
    accessStatus: async () => ({
      loggedIn: previewSignedIn,
      ...(previewAuthOutage ? { outage: "auth" } : {}),
      allowed: previewSignedIn && !previewAccessUnavailable && (!previewAccessDenied || inviteRedeemed),
      isAdmin: !previewTestChannelDenied && !previewMember,
      testAllowed: !previewTestChannelDenied,
      unavailable: previewAccessUnavailable,
      reason: previewAccessUnavailable ? "로그인 세션을 서버에서 인증하지 못했습니다. 다시 로그인해 주세요." : previewAccessDenied ? "초대 코드가 필요합니다." : previewSignedIn ? "초대 확인 완료" : "로그인이 필요합니다.",
      user: previewSignedIn ? { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null } : undefined
    }),
    login: async () => ({ configured: true, pending: true, user: null, message: "브라우저에서 Discord 로그인을 완료해 주세요." }),
    cancelLogin: async () => ({ cancelled: true, message: "로그인을 취소했습니다. 다시 시도할 수 있습니다." }),
    logout: async () => ({ loggedIn: false, allowed: false, isAdmin: false, reason: "로그아웃했습니다." }),
    redeemInvite: async (code) => {
      if (code !== "BWEEP-123456789ABC-123456789ABC") throw new Error(`초대 코드가 정규화되지 않았습니다: ${code}`);
      inviteRedeemed = true;
      return {
        ok: true,
        message: "완료",
        status: { loggedIn: true, allowed: true, isAdmin: false, reason: "허용됨" }
      };
    },
    createInvite: async (maxUses) => {
      const invite = { id: `00000000-0000-0000-0000-${String(invites.length + 1).padStart(12, "0")}`, code: "BWEEP-123456789ABC-123456789ABC", expiresAt: "2026-12-31T00:00:00Z", maxUses };
      invites = [{ id: invite.id, expiresAt: invite.expiresAt, maxUses, uses: 0, createdAt: "2026-09-28T00:00:00Z" }, ...invites];
      return invite;
    },
    listInvites: async () => ({ role: "admin", maxUsesLimit: 20, activeLimit: null, invites }),
    revokeInvite: async (inviteId) => { invites = invites.filter((invite) => invite.id !== inviteId); },
    chooseInstanceRoot: async () => window.__nextInstanceRoot ?? "D:\\Bweeep",
    openLog: async () => undefined,
    stopGame: async () => { window.__stopRequests += 1; },
    setGameProfile: async (gameName) => {
      if (gameName === "noah_sky1012") throw new Error(`Error invoking remote method 'account:setGameProfile': Error: '${gameName}'은(는) 다른 멤버가 쓰고 있거나 하루 안에 쓴 이름이에요.`);
      return { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null, gameName };
    },
    checkLauncherUpdate: async () => ({ state: "current" }),
    installLauncherUpdate: async () => { window.__updateInstallRequests = (window.__updateInstallRequests ?? 0) + 1; },
    launcherChannel: async () => previewTestChannelDenied ? "test" : "production",
    launcherVersion: async () => "0.1.30",
    gameStatus: async () => gameStatus,
    // Shaped like the main process's shortened notes: summary and top-level items only.
    whatsNew: async () => previewWhatsNew && !window.__whatsNewSeen ? {
      version: "0.1.36",
      summary: "패치노트 탭, 테스터 먼저 받기, 모드팩 이어받기, 모드 설정 유지, 이름 규칙 완화까지!",
      intro: null,
      outro: null,
      sections: [
        { kind: "new", title: "새 기능", items: ["왼쪽 메뉴에 패치노트가 생겼어요."] },
        { kind: "changed", title: "바뀐 점", items: [
          "모드팩 다운로드가 빨라졌어요. 끊겨도 받던 데부터 이어받습니다.",
          "이름 규칙이 느슨해졌어요. 게임에서 실제로 쓴 이름만, 바꾼 뒤 하루 동안 내 것으로 남아요."
        ] }
      ]
    } : null,
    markWhatsNewSeen: async (version) => { window.__whatsNewSeen = version; },
    openStableDownload: async () => { window.__stableDownloadOpened = true; },
    patchNotes: async () => {
      const current = {
        version: "0.1.30",
        summary: "패치노트 탭이 생겼고, 테스터는 새 버전을 먼저 받아요.",
        intro: "여러분 안녕하세요?! 월급루팡 클로드입니다.",
        outro: "루팡은 이만 퇴근합니다!",
        sections: [
          {
            kind: "new",
            title: "새 기능",
            items: ["왼쪽 메뉴의 패치노트에서 버전마다 바뀐 점을 볼 수 있어요.", "테스터는 일반 런처에서 테스트 버전을 먼저 받아요."],
            details: [[], ["참고: 이번 한 번만 테스트 버전을 직접 설치해야 해요."]]
          },
          { kind: "fixed", title: "고친 문제", items: ["필요 없어진 붸에엡 전용 모드를 알아서 정리해요."] },
          { kind: "known", title: "알려진 문제", items: ["따로 설치한 '붸에엡 테스트' 런처는 이제 업데이트되지 않아요."] },
          { kind: "upcoming", title: "다음 패치 예고", items: ["여러 가지를 한꺼번에 준비하고 있어요. 뭔지는 아직 비밀입니다."] }
        ],
        prerelease: false,
        publishedAt: previewPatchNotesOffline ? null : "2026-09-28T12:31:39Z",
        url: "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.30"
      };
      if (previewPatchNotesOffline) return { currentVersion: "0.1.30", source: "bundled", notes: [current] };
      return {
        currentVersion: "0.1.30",
        source: "live",
        notes: [
          {
            version: "0.1.31-beta.1",
            summary: "다음 버전을 테스터가 먼저 확인해요.",
            intro: null,
            outro: null,
            sections: [{ kind: "changed", title: "바뀐 점", items: ["서버 목록을 더 빨리 불러와요."] }],
            prerelease: true,
            publishedAt: "2026-09-29T09:00:00Z",
            url: "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.31-beta.1"
          },
          current,
          {
            version: "0.1.29",
            summary: null,
            intro: null,
            outro: null,
            sections: [{ kind: "other", title: null, items: ["스킨 탭이 생겼어요.", "게임은 고른 서버에만 접속돼요."] }],
            prerelease: false,
            publishedAt: "2026-09-20T18:24:04Z",
            url: "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.29"
          }
        ]
      };
    },
    openReleasePage: async (url) => { window.__openedReleasePage = url; },
    launchGame: async (request) => {
      window.__lastLaunchRequest = request;
      window.__launchRequests += 1;
      const startedAt = Date.now();
      emitGameStatus({ state: "starting", startedAt });
      if (window.__exitBeforeLaunchResolves) {
        emitGameStatus({ state: "idle", exitMessage: "Minecraft가 실행 직후 종료되었습니다. (신호 SIGSEGV)", exitError: true });
        return result;
      }
      if (window.__zeroFileSync) {
        listeners.forEach((listener) => listener({ kind: "info", stage: "모드팩 파일", message: "모드팩 파일 검사 중", completed: 0, total: 0 }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        listeners.forEach((listener) => listener({ kind: "info", stage: "게임 실행", message: "Minecraft 실행 명령을 준비하는 중" }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        listeners.forEach((listener) => listener({ kind: "info", stage: "게임 프로세스", message: "Minecraft 프로세스 실행 중 · 서버 참가 확인 전" }));
        emitGameStatus({ state: "running", pid: 4242, startedAt });
        return result;
      }
      listeners.forEach((listener) => listener({ kind: "info", stage: "모드팩 파일", message: "Create Aeronautics 동기화 시작", completed: 0, total: 3 }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      listeners.forEach((listener) => listener({ kind: "download", stage: "모드팩 파일", message: "다운로드: mods/create.jar", completed: 0, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "info", stage: "모드팩 파일", message: "준비 완료: mods/create.jar", completed: 1, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "download", stage: "모드팩 파일", message: "다운로드: mods/aeronautics.jar", completed: 1, total: 3, filePath: "mods/aeronautics.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      listeners.forEach((listener) => listener({ kind: "done", stage: "모드팩 파일", message: "완료", completed: 3, total: 3 }));
      listeners.forEach((listener) => listener({ kind: "info", stage: "게임 프로세스", message: "Minecraft 프로세스 실행 중 · 서버 참가 확인 전" }));
      emitGameStatus({ state: "running", pid: 4242, startedAt });
      return result;
    },
    openPath: async () => "",
    copyText: async (value) => { window.__copiedText = value; },
    readyForInvite: async () => null,
    minimizeWindow: () => undefined,
    closeWindow: () => undefined,
    onAuthSession: () => () => {},
    onAuthError: () => () => {},
    onInviteReceived: () => () => {},
    onLauncherUpdate: (listener) => {
      updateListeners.push(listener);
      return () => {
        const index = updateListeners.indexOf(listener);
        if (index >= 0) updateListeners.splice(index, 1);
      };
    },
    onProgress: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    onGameStatus: (listener) => {
      gameStatusListeners.push(listener);
      return () => {
        const index = gameStatusListeners.indexOf(listener);
        if (index >= 0) gameStatusListeners.splice(index, 1);
      };
    }
  };
}, { previewSignedIn: signedIn, previewAccessUnavailable: accessUnavailable, previewAccessDenied: accessDenied, previewCatalogUnavailable: catalogUnavailable, previewTestChannelDenied: testChannelDenied, previewWhatsNew: whatsNewMode, previewPatchNotesOffline: patchNotesOffline, previewServerOffline: serverOffline, previewAuthOutage: authOutage, previewMoveAndMods: moveAndModsMode, previewMember: memberMode });

await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
if (testChannelDenied) {
  await page.getByText("지정된 테스터만 쓸 수 있어요").waitFor({ timeout: 10000 });
  if (await page.locator(".launchButton").count()) throw new Error("the test build opened for a member who is not a tester");
  await page.screenshot({ path: "previews/bweeep-launcher-test-channel-denied.png" });
  await page.getByRole("button", { name: "일반 런처 받기" }).click();
  await page.waitForFunction(() => window.__stableDownloadOpened === true);
  console.log(JSON.stringify({ interactionChecks: ["test-channel-testers-only", "stable-installer-link"], errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (whatsNewMode) {
  const dialog = page.getByRole("dialog", { name: "업데이트 소식" });
  await dialog.waitFor({ timeout: 10000 });
  const text = await dialog.innerText();
  if (!text.includes("바꾼 뒤 하루 동안 내 것으로 남아요")) throw new Error(`what's new dialog is missing the notes: ${text}`);
  if (!text.includes("새 기능") || !text.includes("바뀐 점")) throw new Error(`what's new dialog is missing the groups: ${text}`);
  if (await dialog.locator(".releaseSubNotes, .releaseSection.is-upcoming").count()) throw new Error("what's new dialog shows sub-notes or the next-patch preview");
  // Same article structure as the patch notes tab: title, meta line, bold summary, headings.
  if ((await dialog.locator(".releaseTitle").innerText()) !== "붸에엡 런처 0.1.36 패치 노트") throw new Error("what's new title is not the patch note title");
  if (!(await dialog.locator(".releaseMeta").innerText()).includes("월급루팡 클로드")) throw new Error("what's new meta line has no author");
  const summary = dialog.locator(".releaseSummary");
  if (!(await summary.innerText()).startsWith("요약: 패치노트 탭") || Number(await summary.evaluate((element) => getComputedStyle(element).fontWeight)) < 700) {
    throw new Error("what's new summary is not a bold 요약 paragraph");
  }
  if (await dialog.locator(".releaseSection h3").count() !== 2) throw new Error("what's new groups are not headings");
  await page.screenshot({ path: "previews/bweeep-launcher-whats-new.png" });
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  if (await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)) throw new Error("what's new dialog overflows sideways at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-whats-new-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: "확인" }).click();
  await page.waitForFunction(() => window.__whatsNewSeen === "0.1.36");
  if (await page.getByRole("dialog", { name: "업데이트 소식" }).count()) throw new Error("what's new dialog did not close");
  await page.locator(".launchButton").waitFor();
  console.log(JSON.stringify({ interactionChecks: ["whats-new-once-after-update"], errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (patchNotesOffline) {
  await page.locator(".launchButton").waitFor();
  await page.getByRole("button", { name: "패치노트", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "패치노트" });
  await panel.getByText("이 버전 내용만 보여요", { exact: false }).waitFor({ timeout: 10000 });
  if (await panel.locator(".patchVersion").count() !== 1) throw new Error("offline patch notes should show only this build's notes");
  if (!(await panel.locator(".patchVersion").innerText()).includes("지금 버전")) throw new Error("the bundled notes are not marked as the current version");
  await page.screenshot({ path: "previews/bweeep-launcher-patch-notes-offline.png" });
  console.log(JSON.stringify({ interactionChecks: ["patch-notes-offline-fallback"], errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (serverOffline) {
  const checks = [];
  await page.locator(".launchButton .launchOffIcon").waitFor({ timeout: 10000 });
  if (!(await page.locator(".serverPill").innerText()).includes("꺼짐")) throw new Error("the top bar does not say the server is off");
  await page.screenshot({ path: "previews/bweeep-launcher-server-offline.png" });
  // Asked once: cancel starts nothing, confirming starts the game, and the next start does not ask again.
  await page.locator(".launchButton").click();
  const dialog = page.getByRole("alertdialog", { name: "서버가 꺼져 있어요" });
  await dialog.waitFor();
  if (!(await dialog.innerText()).includes("그래도 시작할까요?")) throw new Error("the off-server question is wrong");
  await page.screenshot({ path: "previews/bweeep-launcher-server-offline-confirm.png" });
  await dialog.getByRole("button", { name: "취소" }).click();
  if (await page.evaluate(() => window.__launchRequests) !== 0) throw new Error("cancelling still started the game");
  await page.locator(".launchButton").click();
  await dialog.getByRole("button", { name: "시작", exact: true }).click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__exitGame());
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  await page.locator(".launchButton").click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  if (await page.getByRole("alertdialog").count() || await page.evaluate(() => window.__launchRequests) !== 2) throw new Error("the off-server question was asked twice");
  await page.evaluate(() => window.__exitGame());
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  checks.push("offline-launch-asks-once");
  // Minimized (hidden): no status checks. Visible again: checked at once.
  await page.evaluate(() => window.__setHidden(true));
  const hiddenCalls = await page.evaluate(() => window.__serverStatusCalls);
  await page.waitForTimeout(10_800);
  if (await page.evaluate(() => window.__serverStatusCalls) !== hiddenCalls) throw new Error("server status was polled while the window was hidden");
  await page.evaluate(() => { window.__serverBackOnline = true; window.__setHidden(false); });
  await page.waitForFunction((count) => window.__serverStatusCalls > count, hiddenCalls, { timeout: 2000 });
  await page.locator(".launchButton .launchOffIcon").waitFor({ state: "detached" });
  checks.push("polling-paused-while-hidden");
    console.log(JSON.stringify({ interactionChecks: checks, errors }));
    await browser.close();
    process.exit(errors.length ? 1 : 0);
  }
if (moveAndModsMode) {
  const checks = [];
  const noSideways = async (selector, name) => {
    if (await page.locator(selector).evaluate((element) => element.scrollWidth > element.clientWidth + 1)) throw new Error(`${name} overflows sideways`);
  };
  await page.locator(".launchButton").waitFor();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const discordToggle = page.getByRole("checkbox", { name: "디스코드에 플레이 중 표시" });
  if (!(await discordToggle.isChecked())) throw new Error("Discord status is not on by default");
  await discordToggle.click();
  await page.waitForFunction(() => window.__discordEnabled === false);
  if (await discordToggle.isChecked()) throw new Error("Discord status did not turn off");
  checks.push("discord-presence-toggle");

  // Moving: ask first, then show only the percent while it runs.
  await page.locator(".settingsModal .pathRow").getByRole("button", { name: "변경" }).click();
  const dialog = page.getByRole("alertdialog", { name: "설치 위치 바꾸기" });
  await dialog.getByText("지금 파일 3.4GB를 새 위치로 옮길까요?").waitFor();
  await page.screenshot({ path: "previews/bweeep-launcher-install-move-ask.png" });
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  await noSideways(".installMoveDialog", "move dialog");
  await page.screenshot({ path: "previews/bweeep-launcher-install-move-ask-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: "옮기기" }).click();
  await dialog.getByText("37%").waitFor();
  await page.keyboard.press("Escape");
  if (!(await dialog.isVisible()) || !(await page.locator(".settingsModal").isVisible())) throw new Error("Escape closed something while moving");
  await page.screenshot({ path: "previews/bweeep-launcher-install-move-progress.png" });
  await page.evaluate(() => window.__releaseMove());
  await page.getByText("설치 위치 옮김", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__finishedMove === "move-1");
  if ((await page.locator(".settingsModal .pathValue").innerText()) !== "D:\\Bweeep") throw new Error("the new location was not saved after moving");
  checks.push("install-move-progress-and-switch");

  // A refused move still offers downloading again at the new location.
  await page.evaluate(() => { window.__nextInstanceRoot = "D:\\Bweeep\\instances"; });
  await page.locator(".settingsModal .pathRow").getByRole("button", { name: "변경" }).click();
  await dialog.getByText("지금 위치와 겹치는 폴더예요").waitFor();
  if (!(await dialog.getByRole("button", { name: "옮기기" }).isDisabled())) throw new Error("move stayed enabled for an overlapping folder");
  await page.screenshot({ path: "previews/bweeep-launcher-install-move-refused.png" });
  await page.keyboard.press("Escape");
  if (await dialog.count() || !(await page.locator(".settingsModal").isVisible())) throw new Error("Escape should close only the move dialog");
  await page.locator(".settingsModal .pathRow").getByRole("button", { name: "변경" }).click();
  await dialog.getByRole("button", { name: "새로 받기" }).click();
  await page.getByText("설치 위치 바뀜", { exact: true }).waitFor();
  checks.push("install-move-refused-download-again");
  await page.locator(".settingsModal .closeButton").click();

  // Mods left behind by a server update open first, ready to fetch again.
  await page.getByRole("button", { name: "편의 모드", exact: true }).click();
  const mods = page.locator(".modsModal");
  await mods.getByText("NeoForge 1.20.6용 3개").waitFor();
  if ((await mods.getByRole("tab", { name: /설치됨/ }).getAttribute("aria-selected")) !== "true") throw new Error("the installed tab did not open for previous-version mods");
  if (!(await mods.locator(".modItem").filter({ hasText: "Better F3" }).innerText()).includes("맞는 버전 없음")) throw new Error("no-match mod is not marked");
  await page.screenshot({ path: "previews/bweeep-launcher-mods-previous.png" });
  await mods.getByRole("button", { name: "새 버전용으로 다시 받기" }).click();
  await mods.getByText("다시 받음 · 1개는 못 받음").waitFor();
  if (await mods.locator(".modItem.isPrevious").count() !== 1) throw new Error("refetched mods are still listed as previous");
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  await noSideways(".modsModal", "mods panel");
  await page.screenshot({ path: "previews/bweeep-launcher-mods-refetched-narrow.png" });
  checks.push("mods-refetch-for-new-version");
  console.log(JSON.stringify({ interactionChecks: checks, errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (memberMode) {
  await page.locator(".launchButton").waitFor();
  if (await page.getByRole("button", { name: "관리", exact: true }).count()) throw new Error("a member sees the admin tab");
  console.log(JSON.stringify({ interactionChecks: ["admin-tab-hidden-from-members"], errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (adminMode) {
  const checks = [];
  await page.locator(".launchButton").waitFor();
  const narrowOverflow = async (panel) => {
    await page.setViewportSize({ width: 920, height: 620 });
    await page.waitForTimeout(100);
    const overflow = await panel.evaluate((element) => {
      const body = element.querySelector(".modalBody");
      const sideways = element.scrollWidth > element.clientWidth || body.scrollWidth > body.clientWidth;
      const rows = [...element.querySelectorAll(".adminRow")].some((row) => row.scrollWidth > row.clientWidth + 1);
      return sideways || rows;
    });
    return overflow;
  };
  await page.getByRole("button", { name: "관리", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "관리" });
  await panel.locator(".adminRow").first().waitFor();
  if (await page.locator(".settingsModal").count()) throw new Error("the admin tab opened settings");
  const selfRow = panel.locator(".adminRow").filter({ hasText: "붸에엡" });
  if (!(await selfRow.getByRole("button", { name: "관리자" }).isDisabled()) || !(await selfRow.getByRole("button", { name: "내보내기" }).isDisabled())) {
    throw new Error("an admin can demote or remove themselves");
  }
  if (!(await panel.locator(".adminRow").filter({ hasText: "나원" }).innerText()).includes("3일 전 플레이")) throw new Error("last play time is missing");
  checks.push("admin-self-protected", "admin-last-played");
  const nawon = panel.locator(".adminRow").filter({ hasText: "나원" });
  await nawon.getByRole("button", { name: "테스터" }).click();
  await nawon.locator(".adminToggle.isOn").filter({ hasText: "테스터" }).waitFor();
  checks.push("admin-designates-tester");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-members.png" });
  if (await narrowOverflow(panel)) throw new Error("admin members overflow at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-members-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await nawon.getByRole("button", { name: "내보내기" }).click();
  const confirm = page.getByRole("alertdialog");
  if (!(await confirm.innerText()).includes("하루 뒤에 풀리고")) throw new Error("the removal confirmation does not explain what happens");
  await confirm.getByRole("button", { name: "내보내기" }).click();
  await panel.locator(".adminRow").filter({ hasText: "나원" }).waitFor({ state: "detached" });
  checks.push("admin-remove-confirmed");

  await panel.getByRole("tab", { name: "이름" }).click();
  await panel.getByText("nawon_old").waitFor();
  const reservation = panel.locator(".adminRow").filter({ hasText: "creeperppangchae" });
  await reservation.getByRole("button", { name: "예약 해제" }).click();
  const reservationConfirm = await page.getByRole("alertdialog").innerText();
  if (!reservationConfirm.includes("인벤토리") || !reservationConfirm.includes("되돌릴 수 없어요")) throw new Error(`reservation confirmation is not explicit: ${reservationConfirm}`);
  await page.screenshot({ path: "previews/bweeep-launcher-admin-reservation-confirm.png" });
  await page.getByRole("alertdialog").getByRole("button", { name: "취소" }).click();
  if (!(await reservation.count())) throw new Error("cancelling removed the reservation");
  await panel.locator(".adminRow").filter({ hasText: "creeper_bye" }).getByRole("button", { name: "지금 풀기" }).click();
  if (!(await page.getByRole("alertdialog").innerText()).includes("모두 풀려요")) throw new Error("releasing a removed member's name does not say all names go");
  await page.getByRole("alertdialog").getByRole("button", { name: "지금 풀기" }).click();
  await panel.locator(".adminRow").filter({ hasText: "creeper_bye" }).waitFor({ state: "detached" });
  checks.push("admin-name-hold-release", "admin-reservation-confirm");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-names.png" });
  if (await narrowOverflow(panel)) throw new Error("admin names overflow at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-names-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await panel.getByRole("tab", { name: "서버 팩" }).click();
  await panel.getByText("4.1.5-2026.09.29").waitFor();
  const offlineRow = panel.locator(".adminRow").filter({ hasText: "2026.09.20" });
  if (!(await offlineRow.getByRole("button", { name: "이 버전으로" }).isDisabled())) throw new Error("an offline release can be switched on");
  await panel.locator(".adminRow").filter({ hasText: "4.1.5-2026.09.29" }).getByRole("button", { name: "이 버전으로" }).click();
  if (!(await page.getByRole("alertdialog").innerText()).includes("4.1.5-2026.09.28 → 4.1.5-2026.09.29")) throw new Error("the switch confirmation does not show both versions");
  await page.getByRole("alertdialog").getByRole("button", { name: "바꾸기" }).click();
  await panel.locator(".adminRow.isActive").filter({ hasText: "4.1.5-2026.09.29" }).waitFor();
  if (await panel.locator(".adminRow.isActive").count() !== 2) throw new Error("each pack must keep exactly one active release");
  checks.push("admin-release-switch", "admin-offline-release-locked");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-releases.png" });
  if (await narrowOverflow(panel)) throw new Error("admin releases overflow at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-releases-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await panel.getByRole("tab", { name: "진단" }).click();
  await panel.getByText("토큰 만료").waitFor();
  if (!(await panel.innerText()).includes("접속 기록 없음")) throw new Error("an anonymous refusal is missing");
  await panel.locator(".adminRow").filter({ hasText: "183KB" }).getByRole("button", { name: "열기" }).click();
  await page.waitForFunction(() => window.__openedDiagnostics === "20000000-0000-0000-0000-000000000001");
  checks.push("admin-diagnostics-open");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-diagnostics.png" });
  if (await narrowOverflow(panel)) throw new Error("admin diagnostics overflow at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-admin-diagnostics-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  if (await page.getByRole("dialog", { name: "관리" }).count()) throw new Error("Escape did not close the admin tab");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  if ((await page.locator(".settingsModal").innerText()).includes("테스터로 지정")) throw new Error("the tester list is still in settings");
  checks.push("tester-list-moved");
  console.log(JSON.stringify({ interactionChecks: checks, errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
if (authOutage) {
  await page.locator(".launchButton").waitFor({ timeout: 10000 });
  if ((await page.locator(".dockHint").innerText()) !== "인증 서버 점검 중") throw new Error("the auth outage hint is missing");
  if (!(await page.locator(".heroCopy h2").innerText()).includes("Create Aeronautics")) throw new Error("the saved server list is not shown during the outage");
  await page.screenshot({ path: "previews/bweeep-launcher-auth-outage.png" });
  await page.locator(".launchButton").click();
  await page.locator(".dockError").waitFor();
  const lineCount = (element) => {
    const style = getComputedStyle(element);
    const line = Number.isFinite(parseFloat(style.lineHeight)) ? parseFloat(style.lineHeight) : parseFloat(style.fontSize) * 1.4;
    return Math.round(element.getBoundingClientRect().height / line);
  };
  const refusalLines = await page.locator(".dockError strong").evaluate(lineCount);
  if ((await page.locator(".dockError strong").innerText()) !== "인증 서버 점검 중이라 지금은 못 들어가요" || await page.locator(".dockError p").count() || refusalLines > 1) {
    throw new Error(`the outage refusal is not one line (${refusalLines}): ${await page.locator(".dockError").innerText()}`);
  }
  if (await page.evaluate(() => window.__launchRequests) !== 0) throw new Error("the game started during an auth outage");
  await page.screenshot({ path: "previews/bweeep-launcher-auth-outage-launch.png" });
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  if (await page.locator(".dockError strong").evaluate(lineCount) > 1) throw new Error("the outage refusal wraps at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-auth-outage-narrow.png" });
  console.log(JSON.stringify({ interactionChecks: ["auth-outage-saved-servers", "auth-outage-launch-refused-one-line"], errors }));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
const expectedEntrySelector = accessUnavailable ? ".entryActions .primaryButton" : accessDenied ? ".entryInvite" : signedIn ? ".launchButton" : ".entryPrimary";
await page.locator(expectedEntrySelector).waitFor({ state: "visible", timeout: 10000 });
const interactionChecks = [];

async function verifyHover(selector, name) {
  const target = page.locator(selector).first();
  const before = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.backgroundColor}|${style.transform}|${style.boxShadow}`;
  });
  await target.hover();
  await page.waitForTimeout(190);
  const after = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.backgroundColor}|${style.transform}|${style.boxShadow}`;
  });
  if (before === after) throw new Error(`${name} hover state did not change`);
  interactionChecks.push(name);
  await page.mouse.move(1, 1);
}

if (!catalogUnavailable) {
  await verifyHover(accessUnavailable ? ".entryActions .primaryButton" : accessDenied ? ".entryActions .textButton" : signedIn ? ".launchButton" : ".entryPrimary", accessUnavailable ? "recovery" : accessDenied ? "invite-screen" : signedIn ? "launch" : "login");
}
await page.screenshot({ path: accessDenied ? "previews/bweeep-launcher-invite-entry.png" : signedIn ? "previews/bweeep-launcher-flow-ready.png" : "previews/bweeep-launcher-login-main.png" });
if (catalogUnavailable) {
  const mainText = await page.locator("main").innerText();
  if (!mainText.includes("서버 목록 연결 실패") || !mainText.includes("서버에 연결하지 못했어요") || mainText.includes("Create Aeronautics")) {
    throw new Error("catalog failure did not fail closed with a visible reason");
  }
  if (!(await page.getByRole("button", { name: "게임 시작" }).isDisabled())) throw new Error("launch remained enabled without a catalog");
  interactionChecks.push("catalog-failure-closed");
} else if (accessUnavailable) {
  if (await page.getByRole("button", { name: "다시 확인" }).count() !== 1) throw new Error("access recovery action is missing");
  await page.screenshot({ path: "previews/bweeep-launcher-access-recovery.png" });
} else if (accessDenied) {
  await page.locator(".entryInvite input").fill("bweep-123456789abc-123456789abc");
  await page.getByRole("button", { name: "참여" }).click();
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  interactionChecks.push("invite-code-paste");
} else if (signedIn) {
  await page.waitForFunction(() => window.__serverStatusCalls >= 2, null, { timeout: 7_000 });
  interactionChecks.push("live-server-polling");
  const mainText = await page.locator("main").innerText();
  if (mainText.includes("server.fri4666.com") || mainText.includes(":25565")) {
    throw new Error("server address is visible on the main screen");
  }
  // The top bar switches servers and shows each one's players.
  const pillText = await page.locator(".serverPill").innerText();
  if (!pillText.includes("Create Aeronautics") || !pillText.includes("3/20명") || !pillText.includes("18ms")) {
    throw new Error(`the server pill does not show the server and its players: ${pillText}`);
  }
  await page.locator(".serverPillButton").click();
  const serverMenu = page.getByRole("listbox", { name: "서버" });
  await serverMenu.waitFor();
  const menuItems = (await serverMenu.getByRole("option").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  if (menuItems.length !== 2 || !menuItems[0].includes("3/20") || !menuItems[1].includes("테섭") || !menuItems[1].includes("꺼짐")) {
    throw new Error(`server menu is wrong: ${JSON.stringify(menuItems)}`);
  }
  if ((await serverMenu.innerText()).includes("server.fri4666.com")) throw new Error("the server menu shows addresses");
  await page.screenshot({ path: "previews/bweeep-launcher-server-menu.png" });
  await serverMenu.getByRole("option", { name: /Vanilla Test/ }).click();
  await page.locator(".heroCopy h2").filter({ hasText: "Vanilla Test" }).waitFor();
  if (await page.evaluate(() => localStorage.getItem("bweeep.selected-pack-id")) !== "vanilla-survival-test") throw new Error("the switched server was not saved");
  if (!(await page.locator(".launchButton .launchOffIcon").count())) throw new Error("an off server shows no mark on the launch button");
  await page.locator(".serverPillButton").click();
  await serverMenu.getByRole("option", { name: /Create Aeronautics/ }).click();
  await page.locator(".heroCopy h2").filter({ hasText: "Create Aeronautics" }).waitFor();
  if (await serverMenu.count()) throw new Error("the server menu stayed open after choosing");
  interactionChecks.push("main-screen-server-switch");
  if (await page.locator(".updatePanel, .updateModal, .progressTrack").count()) {
    throw new Error("obsolete update or progress UI remained on the main screen");
  }
  if (mainText.includes("0개 파일 중 0개 처리") || mainText.includes("서버 파일 목록을 확인하는 중")) {
    throw new Error("misleading empty download progress remained on the main screen");
  }
  interactionChecks.push("server-address-hidden");
  if (!(await page.locator(".quickFact").filter({ hasText: /^서버/ }).innerText()).includes("Fabric 서버")
    || !(await page.locator(".quickFact").filter({ hasText: "클라이언트" }).innerText()).includes("NeoForge")) {
    throw new Error("server loader metadata was not displayed separately from the client loader");
  }
  interactionChecks.push("server-loader-visible");
  // The smallest window (920x620): the launch button must not cover the server chips.
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(150);
  const narrowLayout = await page.evaluate(() => {
    const box = (element) => element.getBoundingClientRect();
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const dock = box(document.querySelector(".actionDock"));
    const copy = document.querySelector(".heroCopy");
    const chips = [...document.querySelectorAll(".chips span")].map(box);
    return {
      chipOverlap: chips.some((chip) => overlaps(chip, dock)),
      copyOverlap: overlaps(box(copy), dock),
      chips: chips.length,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  await page.screenshot({ path: "previews/bweeep-launcher-narrow.png" });
  if (narrowLayout.chips === 0 || narrowLayout.chipOverlap || narrowLayout.copyOverlap || narrowLayout.horizontalScroll) {
    throw new Error(`narrow window layout overlaps: ${JSON.stringify(narrowLayout)}`);
  }
  await page.locator(".serverPillButton").click();
  const narrowMenu = await page.evaluate(() => {
    const menu = document.querySelector(".serverMenu").getBoundingClientRect();
    const items = [...document.querySelectorAll(".serverMenuItem")].map((item) => item.scrollWidth <= item.clientWidth);
    return { inside: menu.right <= window.innerWidth && menu.bottom <= window.innerHeight, itemsFit: items.every(Boolean) };
  });
  await page.screenshot({ path: "previews/bweeep-launcher-server-menu-narrow.png" });
  if (!narrowMenu.inside || !narrowMenu.itemsFit) throw new Error(`server menu does not fit at 920px: ${JSON.stringify(narrowMenu)}`);
  await page.keyboard.press("Escape");
  await page.locator(".serverMenu").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  interactionChecks.push("narrow-window-no-overlap");
  const indicator = page.locator(".updateIndicator");
  await page.evaluate(() => window.__emitUpdate({ state: "downloading", update: { version: "0.1.31", notes: ["긴 업데이트 설명은 화면에 나오면 안 돼요."] }, percent: 42 }));
  await indicator.waitFor();
  if ((await indicator.innerText()).trim() !== "42%" || await indicator.locator("svg").count() !== 1 || await indicator.getAttribute("aria-label") !== "업데이트 받는 중") {
    throw new Error(`update download should show only an icon and the percent: ${await indicator.innerText()}`);
  }
  await page.locator(".topbar").screenshot({ path: "previews/bweeep-launcher-update-downloading.png" });
  for (const [state, label] of [["ready", "업데이트 준비됨"], ["installing", "다시 시작하는 중"], ["checking", "업데이트 확인 중"]]) {
    await page.evaluate((next) => window.__emitUpdate({ state: next, update: { version: "0.1.31", notes: [] } }), state);
    await page.locator(`.updateIndicator.is-${state}`).waitFor();
    if ((await indicator.innerText()).trim() !== "" || await indicator.getAttribute("aria-label") !== label) {
      throw new Error(`update ${state} should be icon-only: ${await indicator.innerText()}`);
    }
  }
  if ((await page.locator(".topbar").innerText()).includes("업데이트")) throw new Error("update words are written on screen");
  // After a crash the update waits; a click on the ready icon restarts into it.
  await page.evaluate(() => window.__emitUpdate({ state: "ready", update: { version: "0.1.31", notes: [] } }));
  await page.locator("button.updateIndicator.is-ready").click();
  await page.waitForFunction(() => window.__updateInstallRequests === 1);
  interactionChecks.push("update-ready-click-installs");
  await page.evaluate(() => window.__emitUpdate({ state: "current" }));
  await indicator.waitFor({ state: "detached" });
  interactionChecks.push("update-icon-and-percent-only");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.waitForTimeout(100);
  const settingsText = await page.locator(".settingsModal").innerText();
  if (!settingsText.includes("본섭") || !settingsText.includes("테섭")) {
    throw new Error("production/test server choices are missing from settings");
  }
  interactionChecks.push("server-choice-in-settings");
  if (!settingsText.includes("붸에엡 v0.1.30")) {
    throw new Error("launcher version is missing from the settings footer");
  }
  interactionChecks.push("launcher-version-in-settings");
  // Game memory per server: automatic by default, a warning below the recommendation.
  const memoryRows = page.locator(".memoryRow");
  if (await memoryRows.count() !== 2) throw new Error("game memory is not listed per server");
  if ((await memoryRows.nth(0).locator(".memoryValue").innerText()) !== "자동 6GB" || (await memoryRows.nth(1).locator(".memoryValue").innerText()) !== "자동 3GB") {
    throw new Error(`automatic memory is wrong: ${await page.locator(".memoryList").innerText()}`);
  }
  if (await page.locator(".memoryValue.isLow").count()) throw new Error("automatic memory warns on a 16GB PC");
  await memoryRows.nth(0).getByRole("slider").press("Home");
  await memoryRows.nth(0).locator(".memoryValue.isLow", { hasText: "2GB" }).waitFor();
  if (await memoryRows.nth(0).getByRole("img", { name: "권장 6GB보다 적어요" }).count() !== 1) throw new Error("low memory has no warning icon");
  await page.locator(".panel").filter({ hasText: "게임 메모리" }).screenshot({ path: "previews/bweeep-launcher-memory.png" });
  await memoryRows.nth(1).getByRole("slider").press("End");
  if ((await memoryRows.nth(1).locator(".memoryValue").innerText()) !== "14GB") throw new Error("the slider does not reach PC memory minus 2GB");
  await memoryRows.nth(1).getByRole("button", { name: "자동" }).click();
  if ((await memoryRows.nth(1).locator(".memoryValue").innerText()) !== "자동 3GB") throw new Error("자동 did not reset the memory");
  interactionChecks.push("memory-per-server");
  await page.getByRole("radio", { name: "10명" }).click();
  await page.getByRole("button", { name: "10명용 초대 만들기" }).click();
  await page.getByText("BWEEP-123456789ABC-123456789ABC", { exact: true }).waitFor();
  // Memory and Discord rows push the invite below the fold of the scrolling settings body.
  await page.getByRole("button", { name: "코드 복사" }).scrollIntoViewIfNeeded();
  const copyButtonBox = await page.getByRole("button", { name: "코드 복사" }).boundingBox();
  if (!copyButtonBox || copyButtonBox.x + copyButtonBox.width > 1440) throw new Error("invite code copy action is not visible");
  const copyButtonCenter = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return {
      tagName: hit?.tagName,
      text: hit?.textContent,
      appRegion: hit ? getComputedStyle(hit).getPropertyValue("-webkit-app-region") : ""
    };
  }, { x: copyButtonBox.x + copyButtonBox.width / 2, y: copyButtonBox.y + copyButtonBox.height / 2 });
  if (copyButtonCenter.tagName !== "BUTTON" || copyButtonCenter.text !== "코드 복사" || copyButtonCenter.appRegion !== "no-drag") {
    throw new Error(`invite copy center is not clickable: ${JSON.stringify(copyButtonCenter)}`);
  }
  await page.mouse.click(copyButtonBox.x + copyButtonBox.width / 2, copyButtonBox.y + copyButtonBox.height / 2);
  await page.getByRole("button", { name: "복사됨" }).waitFor();
  const copiedText = await page.evaluate(() => window.__copiedText);
  if (copiedText !== "BWEEP-123456789ABC-123456789ABC") throw new Error(`wrong invite code copied: ${copiedText}`);
  interactionChecks.push("invite-code-copy");
  await page.locator(".inviteItem").getByRole("button", { name: "취소" }).click();
  await page.locator(".inviteItem").waitFor({ state: "detached" });
  interactionChecks.push("invite-revoke");
  await page.keyboard.press("Escape");
  if (await page.locator(".settingsModal").count()) throw new Error("Escape did not close the settings modal");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  interactionChecks.push("escape-closes-modal");
  await page.screenshot({ path: "previews/bweeep-launcher-settings-preview.png" });
  await page.locator(".settingsModal .closeButton").click();

  await page.getByRole("button", { name: "스킨", exact: true }).click();
  await page.locator(".skinModal .skinCanvas").waitFor();
  if (await page.locator(".skinModal .skinCard").count() !== 5) throw new Error("skin library should show the add card, two saved skins and Steve/Alex");
  if (!(await page.locator(".skinCard.active").innerText()).includes("사용 중")) throw new Error("the applied skin is not marked as in use");
  const canvasBox = await page.locator(".skinCanvas").boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 120, canvasBox.y + canvasBox.height / 2, { steps: 8 });
  await page.mouse.up();
  interactionChecks.push("skin-preview-drag-rotate");
  await page.locator(".skinCardPick").filter({ hasText: "보라 기사" }).click();
  await page.getByRole("button", { name: "이 스킨 적용" }).click();
  await page.getByText("스킨 적용됨 · 다음 접속부터").waitFor();
  if (!(await page.locator(".skinCard.active").innerText()).includes("보라 기사")) throw new Error("applying a library skin did not make it current");
  await page.getByRole("button", { name: "새 스킨" }).click();
  await page.locator(".skinCardPick").filter({ hasText: "새로 넣은 스킨" }).waitFor();
  interactionChecks.push("skin-library-apply-and-add");
  await page.waitForTimeout(800);
  const newCardDrawn = await page.locator(".skinCardPick").filter({ hasText: "새로 넣은 스킨" }).locator("canvas").evaluate((canvas) =>
    canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0));
  if (!newCardDrawn) throw new Error("the added skin's card thumbnail stayed empty");
  await page.screenshot({ path: "previews/bweeep-launcher-skins.png" });
  await page.keyboard.press("Escape");
  if (await page.locator(".skinModal").count()) throw new Error("Escape did not close the skin modal");

  await page.getByRole("button", { name: "편의 모드", exact: true }).click();
  await page.locator(".modItem").first().waitFor();
  const modsText = await page.locator(".modsModal").innerText();
  if (!modsText.includes("NeoForge · Minecraft 1.21.1용") || !modsText.includes("서버 팩에 포함") || !modsText.includes("서버에서 막음")) {
    throw new Error("mod search does not show the server's loader, pack mods and blocked mods");
  }
  await page.locator(".modItem").filter({ hasText: "Sodium" }).getByRole("button", { name: "설치" }).click();
  await page.getByText("Sodium 설치됨").waitFor();
  if (!(await page.locator(".modItem").filter({ hasText: "Sodium" }).innerText()).includes("설치됨")) throw new Error("installed mod is not marked");
  await page.screenshot({ path: "previews/bweeep-launcher-mods.png" });
  await page.getByLabel("모드 검색").fill("fabulously optimized modpack");
  await page.getByText("Fabulously Optimized은(는) 모드팩이라 받을 수 없어요.", { exact: false }).waitFor();
  if (await page.locator(".modList .modItem").count() !== 0) throw new Error("modpack search still offers something to install");
  await page.screenshot({ path: "previews/bweeep-launcher-mods-modpack.png" });
  await page.getByLabel("모드 검색").fill("");
  await page.locator(".modItem").first().waitFor();
  interactionChecks.push("modpack-download-refused");
  await page.getByRole("tab", { name: /설치됨/ }).click();
  await page.locator(".modItem").filter({ hasText: "Sodium" }).getByRole("button", { name: "삭제" }).waitFor();
  interactionChecks.push("personal-mod-search-install");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "패치노트", exact: true }).click();
  const patchNotes = page.getByRole("dialog", { name: "패치노트" });
  await patchNotes.locator(".patchVersion").first().waitFor();
  const versions = await patchNotes.locator(".patchVersion strong").allInnerTexts();
  if (versions.join(",") !== "v0.1.31-beta.1,v0.1.30,v0.1.29") throw new Error(`patch notes are not newest first: ${versions}`);
  if (!(await patchNotes.locator(".patchVersion").nth(0).innerText()).includes("테스트")) throw new Error("a beta is not marked as a test build");
  if (!(await patchNotes.locator(".patchVersion").nth(1).innerText()).includes("지금 버전")) throw new Error("the running version is not marked");
  await patchNotes.locator(".patchVersion").nth(1).click();
  const detail = await patchNotes.locator(".patchDetail").innerText();
  for (const expected of ["패치노트 탭이 생겼고", "월급루팡 클로드입니다", "새 기능", "고친 문제", "알려진 문제", "다음 패치 예고", "루팡은 이만 퇴근합니다!"]) {
    if (!detail.includes(expected)) throw new Error(`patch note detail is missing ${expected}: ${detail}`);
  }
  // Article structure: title, subtitle, divider, meta line with author and date, bold 요약, headings, nested notes.
  if ((await patchNotes.locator(".patchDetail .releaseTitle").innerText()) !== "붸에엡 런처 0.1.30 패치 노트") throw new Error("the article title is wrong");
  if (!(await patchNotes.locator(".patchSubtitle").innerText()).trim()) throw new Error("the article has no subtitle");
  if (await patchNotes.locator(".patchHead").evaluate((element) => getComputedStyle(element).borderBottomWidth) !== "1px") throw new Error("the title has no thin divider");
  const meta = await patchNotes.locator(".patchDetail .releaseMeta").innerText();
  if (!meta.includes("런처 업데이트") || !meta.includes("월급루팡 클로드") || !meta.includes("2026년 9월 28일")) throw new Error(`the meta line is wrong: ${meta}`);
  const articleSummary = patchNotes.locator(".patchDetail .releaseSummary");
  if (!(await articleSummary.innerText()).startsWith("요약: ") || Number(await articleSummary.evaluate((element) => getComputedStyle(element).fontWeight)) < 700) {
    throw new Error("the 요약 paragraph is not bold");
  }
  if (await patchNotes.locator(".releaseSection h3").count() !== 4) throw new Error("patch note groups are not shown as headings");
  if (await patchNotes.locator(".releaseList").first().evaluate((element) => getComputedStyle(element).listStyleType) !== "disc") throw new Error("bullets are not plain discs");
  const noteItem = patchNotes.locator(".releaseSection.is-new > .releaseList > li").nth(1);
  const subNote = noteItem.locator(":scope > .releaseSubNotes > li");
  if (await subNote.count() !== 1 || !(await subNote.innerText()).startsWith("참고:")) throw new Error("the 참고 note is not nested under its item");
  const [itemSize, noteSize] = await Promise.all([
    noteItem.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    subNote.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  ]);
  if (!(noteSize < itemSize)) throw new Error("the sub-note is not smaller than its item");
  if (await patchNotes.locator(".releaseSection.is-upcoming li").count() !== 1) throw new Error("the next-patch preview is missing from the patch notes");
  interactionChecks.push("patch-notes-article-structure");
  interactionChecks.push("patch-notes-sub-notes-and-preview");
  await page.screenshot({ path: "previews/bweeep-launcher-patch-notes.png" });
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  if (await patchNotes.locator(".patchDetail").evaluate((element) => element.scrollWidth > element.clientWidth)) throw new Error("the patch note article overflows sideways at 920px");
  await page.screenshot({ path: "previews/bweeep-launcher-patch-notes-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await patchNotes.getByRole("button", { name: "자세히 보기" }).click();
  await page.waitForFunction(() => window.__openedReleasePage === "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.30");
  await patchNotes.locator(".patchVersion").nth(2).click();
  if (await patchNotes.locator(".releaseSection h3").count() !== 0 || await patchNotes.locator(".patchDetail li").count() !== 2) {
    throw new Error("a plain list without headings is not shown as one list");
  }
  interactionChecks.push("patch-notes-newest-first");
  await page.keyboard.press("Escape");
  if (await page.getByRole("dialog", { name: "패치노트" }).count()) throw new Error("Escape did not close the patch notes");
  await page.locator(".profileBox").click();
  await page.getByRole("button", { name: "모드 폴더 선택" }).waitFor();
  if (await page.locator(".contentFolderItem").count() !== 2) throw new Error("saved personal content folders are missing");
  await page.locator(".profileModal input[maxlength='16']").fill("noah_sky1012");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByText("다른 멤버가 쓰고 있거나 하루 안에 쓴 이름이에요", { exact: false }).waitFor();
  interactionChecks.push("taken-name-refused");
  await page.locator(".profileModal input[maxlength='16']").fill("seos_py_new");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByText("이름 바뀜 · 다음 실행부터", { exact: true }).waitFor();
  // Changing a saved name says, in one line, that the old one stays yours for a day.
  await page.locator(".profileModal input[maxlength='16']").fill("seos_py_next");
  const holdNote = await page.locator(".profileModal .fieldNote").innerText();
  if (holdNote !== "seos_py_new은(는) 하루 동안 내 이름으로 남아요.") throw new Error(`name hold note is wrong: ${holdNote}`);
  if (await page.locator(".profileModal .fieldWarning").count()) throw new Error("the old vanilla rename warning is still shown");
  await page.locator(".profileModal input[maxlength='16']").fill("seos_py_new");
  if (await page.locator(".profileModal .fieldNote").count()) throw new Error("the hold note stays when the name is unchanged");
  interactionChecks.push("name-hold-note");
  await page.getByRole("button", { name: "모드 폴더 선택" }).click();
  await page.getByText("모드 폴더 추가됨", { exact: true }).waitFor();
  await page.screenshot({ path: "previews/bweeep-launcher-profile-preview.png" });
  interactionChecks.push("personal-content-folder-settings");
  interactionChecks.push("successful-actions-toast");
  await page.locator(".profileModal .closeButton").click();
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 시작 중" }).waitFor();
  if (!(await page.getByRole("button", { name: "게임 시작 중" }).isDisabled())) throw new Error("launch button was not locked while starting");
  if (await page.evaluate(() => window.__lastLaunchRequest?.memoryMb) !== 2048) throw new Error("the chosen memory was not sent with the launch");
  interactionChecks.push("memory-sent-with-launch");
  await page.waitForTimeout(480);
  if (await page.locator(".launchProgress").count() !== 1 || !(await page.locator(".launchProgress").innerText()).includes("33%")) {
    throw new Error("actual file progress was not visible during launch");
  }
  if (await page.locator(".updatePanel, .progressTrack, .launchProgressHistory").count()) throw new Error("obsolete progress panel or stale stage history returned during launch");
  if (await page.locator(".launchProgressHeading strong").evaluate((element) => getComputedStyle(element).whiteSpace) !== "nowrap") throw new Error("active progress message is not constrained to one line");
  await page.screenshot({ path: "previews/bweeep-launcher-flow-downloading.png" });
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  if (!(await page.getByRole("button", { name: "게임 실행 중" }).isDisabled())) throw new Error("launch button was not locked while running");
  if (!(await page.locator(".launchProgress").innerText()).includes("게임 실행 중")) {
    throw new Error("running Minecraft process was not shown with an honest connection state");
  }
  await page.screenshot({ path: "previews/bweeep-launcher-game-running.png" });
  await page.getByRole("button", { name: "게임 종료" }).click();
  await page.getByRole("button", { name: "강제 종료" }).click();
  if (await page.evaluate(() => window.__stopRequests) !== 1) throw new Error("stop game did not reach the main process");
  interactionChecks.push("stop-game-confirmed");
  await page.evaluate(() => window.__exitGame());
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  if (await page.locator(".launchProgress").count()) throw new Error("progress remained after game exit");
  if (await page.getByText("Minecraft가 종료되었습니다.", { exact: true }).count()) throw new Error("normal game exit message was shown");
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after exit");
  await page.evaluate(() => { window.__zeroFileSync = true; });
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 시작 중" }).waitFor();
  const emptyProgress = await page.locator(".launchProgress").innerText();
  if (!emptyProgress.includes("모드팩 파일") || emptyProgress.includes("0%") || emptyProgress.includes("0개 파일 중 0개 처리")) {
    throw new Error(`empty manifest showed fake progress: ${emptyProgress}`);
  }
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => { window.__zeroFileSync = false; window.__exitGame(); });
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  interactionChecks.push("truthful-empty-progress");
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__rejectGame());
  await page.getByText("선택 서버가 연결을 거절했습니다.").waitFor();
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after a rejected connection");
  interactionChecks.push("connection-rejection-visible");
  // The account API's reason replaces the generic line: an icon and one sentence.
  await page.evaluate(() => window.__authFailure("token_expired"));
  const refusal = page.locator(".dockError .authFailureLine");
  await refusal.waitFor();
  const refusalText = (await refusal.innerText()).trim();
  if (refusalText !== "접속 토큰이 만료됐어요" || await refusal.locator("svg").count() !== 1) {
    throw new Error(`refusal reason is not an icon and one line: ${refusalText}`);
  }
  await page.screenshot({ path: "previews/bweeep-launcher-auth-failure.png" });
  await page.getByRole("button", { name: "진단 정보 보내기" }).click();
  await page.getByRole("button", { name: "진단 정보 보냄" }).waitFor();
  if (await page.evaluate(() => window.__diagnosticsSent) !== 1) throw new Error("diagnostics were not sent");
  await page.setViewportSize({ width: 920, height: 620 });
  await page.waitForTimeout(100);
  const narrowRefusal = await refusal.evaluate((element) => {
    const span = element.querySelector("span");
    return span.getClientRects().length === 1 && span.getBoundingClientRect().height < parseFloat(getComputedStyle(span).fontSize) * 2;
  });
  if (!narrowRefusal) throw new Error("the refusal reason wraps at 920px");
  const sidebarFits = await page.evaluate(() => [...document.querySelectorAll(".sideAction")].every((button) => button.getBoundingClientRect().bottom <= window.innerHeight));
  if (!sidebarFits) throw new Error("menu buttons are cut off at 920x620");
  await page.screenshot({ path: "previews/bweeep-launcher-auth-failure-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  interactionChecks.push("auth-failure-reason", "diagnostics-send");
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__failGame());
  await page.getByText("Minecraft가 비정상 종료되었습니다. (신호 SIGSEGV)").waitFor();
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after a crash");
  await page.evaluate(() => window.__authFailure("token_revoked"));
  await page.waitForTimeout(50);
  if (await page.locator(".dockError .authFailureLine").count()) throw new Error("a refusal replaced the crash message");
  interactionChecks.push("crash-stays-over-refusal");
  await page.evaluate(() => { window.__exitBeforeLaunchResolves = true; });
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByText("Minecraft가 실행 직후 종료되었습니다. (신호 SIGSEGV)").waitFor();
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after an immediate exit");
  await page.screenshot({ path: "previews/bweeep-launcher-game-exit.png" });
  interactionChecks.push("game-exit-visible");
  interactionChecks.push("game-lifecycle-lock");
  await page.evaluate(() => { window.__exitBeforeLaunchResolves = false; });
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__failWithPersonalMods());
  await page.getByText("개인 모드 때문일 수 있어요", { exact: false }).waitFor();
  await page.screenshot({ path: "previews/bweeep-launcher-retry-without-mods.png" });
  await page.getByRole("button", { name: "개인 모드 빼고 시작" }).click();
  await page.waitForFunction(() => window.__lastLaunchRequest?.withoutPersonalMods === true);
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__exitGame());
  interactionChecks.push("retry-without-personal-mods");
} else {
  await page.getByRole("button", { name: "Discord로 로그인" }).click();
  await page.getByRole("button", { name: "로그인 중" }).waitFor();
  if (await page.getByRole("button", { name: /Microsoft/ }).count()) {
    throw new Error("Microsoft login remained visible");
  }
  await page.getByRole("button", { name: "로그인 취소" }).click();
  if (await page.getByRole("button", { name: "Discord로 로그인" }).isDisabled()) {
    throw new Error("Discord login did not unlock after cancellation");
  }
  interactionChecks.push("login-lock-and-cancel");
  await page.screenshot({ path: "previews/bweeep-launcher-login-preview.png" });
}

console.log(JSON.stringify({
  bodyHasContent: (await page.locator("body").innerText()).trim().length > 0,
  hasErrorOverlay: await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count() > 0,
  interactionChecks,
  errors
}));

await browser.close();
