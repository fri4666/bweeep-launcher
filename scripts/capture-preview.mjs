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
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({ previewSignedIn, previewAccessUnavailable, previewAccessDenied, previewCatalogUnavailable, previewTestChannelDenied, previewWhatsNew, previewPatchNotesOffline }) => {
  const listeners = [];
  const gameStatusListeners = [];
  const updateListeners = [];
  window.__emitUpdate = (status) => updateListeners.forEach((listener) => listener(status));
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
    { userId: "00000000-0000-0000-0000-000000000001", name: "붸에엡", gameName: "seos_py", role: "admin", tester: true },
    { userId: "00000000-0000-0000-0000-000000000002", name: "나원", gameName: null, role: "member", tester: false }
  ];
  let personalMods = [];
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
          blockedModrinthProjects: ["zbhsCnsA"]
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
          blockedModrinthProjects: []
        }
      ];
    },
    listMembers: async () => members,
    setTester: async (userId, tester) => {
      members = members.map((member) => member.userId === userId ? { ...member, tester } : member);
      return members;
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
    defaultInstanceRoot: async () => "C:\\Bweeep\\instances",
    userContentFolders: async () => ({ mods: ["D:\\Minecraft\\my-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders"] }),
    chooseUserContentFolders: async (_root, kind) => ({ folders: kind === "mods" ? { mods: ["D:\\Minecraft\\my-mods", "D:\\Minecraft\\more-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders"] } : { mods: ["D:\\Minecraft\\my-mods"], shaderpacks: ["D:\\Minecraft\\my-shaders", "D:\\Minecraft\\more-shaders"] }, selected: 1 }),
    removeUserContentFolder: async (_root, kind, folder) => ({ mods: kind === "mods" ? [] : ["D:\\Minecraft\\my-mods"], shaderpacks: kind === "shaderpacks" ? [] : ["D:\\Minecraft\\my-shaders"] }),
    serverStatus: async () => {
      window.__serverStatusCalls += 1;
      return {
        online: true,
        host: "server.fri4666.com",
        port: 25565,
        latencyMs: 18,
        message: "서버 연결 가능"
      };
    },
    accessStatus: async () => ({
      loggedIn: previewSignedIn,
      allowed: previewSignedIn && !previewAccessUnavailable && (!previewAccessDenied || inviteRedeemed),
      isAdmin: !previewTestChannelDenied,
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
    chooseInstanceRoot: async () => "D:\\Bweeep",
    openLog: async () => undefined,
    stopGame: async () => { window.__stopRequests += 1; },
    setGameProfile: async (gameName) => {
      if (gameName === "noah_sky1012") throw new Error(`Error invoking remote method 'account:setGameProfile': Error: '${gameName}'은(는) 다른 멤버가 쓰고 있거나 예전에 쓴 이름이라 쓸 수 없습니다.`);
      return { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null, gameName };
    },
    checkLauncherUpdate: async () => ({ state: "current" }),
    launcherChannel: async () => previewTestChannelDenied ? "test" : "production",
    launcherVersion: async () => "0.1.30",
    gameStatus: async () => gameStatus,
    whatsNew: async () => previewWhatsNew && !window.__whatsNewSeen ? {
      version: "0.1.35",
      summary: "스킨 탭이 생기고, 이름과 접속 서버를 더 단단히 지켜요.",
      intro: null,
      outro: null,
      sections: [
        { kind: "new", title: "새 기능", items: ["스킨 탭이 생겼어요. 스킨을 3D로 돌려 보고 바로 적용할 수 있어요."] },
        { kind: "changed", title: "바뀐 점", items: [
          "다른 멤버가 지금 쓰거나 예전에 쓴 이름은 쓸 수 없어요. 캐릭터와 OP가 이름을 따라 넘어가지 않아요.",
          "게임은 고른 서버에만 접속돼요."
        ] }
      ]
    } : null,
    markWhatsNewSeen: async (version) => { window.__whatsNewSeen = version; },
    openStableDownload: async () => { window.__stableDownloadOpened = true; },
    patchNotes: async () => {
      const current = {
        version: "0.1.30",
        summary: "패치노트 탭이 생겼고, 테스터는 새 버전을 먼저 받아요.",
        intro: "안녕하세요, 붸에엡 런처 개발자입니다!",
        outro: "다음 패치에서 뵙겠습니다!",
        sections: [
          { kind: "new", title: "새 기능", items: ["왼쪽 메뉴의 패치노트에서 버전마다 바뀐 점을 볼 수 있어요.", "테스터는 일반 런처에서 테스트 버전을 먼저 받아요."] },
          { kind: "fixed", title: "고친 문제", items: ["필요 없어진 붸에엡 전용 모드를 알아서 정리해요."] },
          { kind: "known", title: "알려진 문제", items: ["따로 설치한 '붸에엡 테스트' 런처는 이제 업데이트되지 않아요."] }
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
}, { previewSignedIn: signedIn, previewAccessUnavailable: accessUnavailable, previewAccessDenied: accessDenied, previewCatalogUnavailable: catalogUnavailable, previewTestChannelDenied: testChannelDenied, previewWhatsNew: whatsNewMode, previewPatchNotesOffline: patchNotesOffline });

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
  if (!text.includes("v0.1.35") || !text.includes("예전에 쓴 이름은 쓸 수 없어요")) throw new Error(`what's new dialog is missing the notes: ${text}`);
  if (!text.includes("이름과 접속 서버를 더 단단히 지켜요") || !text.includes("새 기능") || !text.includes("바뀐 점")) throw new Error(`what's new dialog is missing the summary or groups: ${text}`);
  await page.screenshot({ path: "previews/bweeep-launcher-whats-new.png" });
  await dialog.getByRole("button", { name: "확인" }).click();
  await page.waitForFunction(() => window.__whatsNewSeen === "0.1.35");
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
  if (!(await panel.locator(".patchDetail").innerText()).includes("지금 버전")) throw new Error("the bundled notes are not marked as the current version");
  await page.screenshot({ path: "previews/bweeep-launcher-patch-notes-offline.png" });
  console.log(JSON.stringify({ interactionChecks: ["patch-notes-offline-fallback"], errors }));
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
  if (mainText.includes("서버 선택")) {
    throw new Error("server picker remained on the main screen");
  }
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
  const serverFact = await page.locator(".serverPill").innerText();
  if (!serverFact.includes("방금 전") || /\d{1,2}시\s*\d{1,2}분|\d{1,2}:\d{2}/.test(serverFact)) {
    throw new Error(`server checked time is not relative: ${serverFact}`);
  }
  interactionChecks.push("relative-server-time");
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
  await page.getByRole("radio", { name: "10명" }).click();
  await page.getByRole("button", { name: "10명용 초대 만들기" }).click();
  await page.getByText("BWEEP-123456789ABC-123456789ABC", { exact: true }).waitFor();
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
  await page.getByRole("button", { name: "테스터로 지정" }).click();
  await page.getByRole("button", { name: "테스터 해제" }).waitFor();
  interactionChecks.push("admin-designates-tester");
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
  for (const expected of ["v0.1.30", "패치노트 탭이 생겼고", "안녕하세요, 붸에엡 런처 개발자입니다!", "새 기능", "고친 문제", "알려진 문제", "다음 패치에서 뵙겠습니다!", "2026년 9월 28일"]) {
    if (!detail.includes(expected)) throw new Error(`patch note detail is missing ${expected}: ${detail}`);
  }
  if (await patchNotes.locator(".releaseSection h4").count() !== 3) throw new Error("patch note groups are not shown as headings");
  await page.screenshot({ path: "previews/bweeep-launcher-patch-notes.png" });
  await patchNotes.getByRole("button", { name: "자세히 보기" }).click();
  await page.waitForFunction(() => window.__openedReleasePage === "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.30");
  await patchNotes.locator(".patchVersion").nth(2).click();
  if (await patchNotes.locator(".releaseSection h4").count() !== 0 || await patchNotes.locator(".patchDetail li").count() !== 2) {
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
  await page.getByText("다른 멤버가 쓰고 있거나 예전에 쓴 이름이라 쓸 수 없습니다", { exact: false }).waitFor();
  interactionChecks.push("taken-name-refused");
  await page.locator(".profileModal input[maxlength='16']").fill("seos_py_new");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByText("이름 바뀜 · 다음 실행부터", { exact: true }).waitFor();
  await page.getByRole("button", { name: "모드 폴더 선택" }).click();
  await page.getByText("모드 폴더 추가됨", { exact: true }).waitFor();
  await page.screenshot({ path: "previews/bweeep-launcher-profile-preview.png" });
  interactionChecks.push("personal-content-folder-settings");
  interactionChecks.push("successful-actions-toast");
  await page.locator(".profileModal .closeButton").click();
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 시작 중" }).waitFor();
  if (!(await page.getByRole("button", { name: "게임 시작 중" }).isDisabled())) throw new Error("launch button was not locked while starting");
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
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 실행 중" }).waitFor();
  await page.evaluate(() => window.__failGame());
  await page.getByText("Minecraft가 비정상 종료되었습니다. (신호 SIGSEGV)").waitFor();
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after a crash");
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
