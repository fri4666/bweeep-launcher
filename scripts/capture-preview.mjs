import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
const signedIn = process.env.BWEEP_PREVIEW_SIGNED_IN !== "false";
const accessUnavailable = process.env.BWEEP_PREVIEW_ACCESS_UNAVAILABLE === "true";
const accessDenied = process.env.BWEEP_PREVIEW_ACCESS_DENIED === "true";
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({ previewSignedIn, previewAccessUnavailable, previewAccessDenied }) => {
  const listeners = [];
  const gameStatusListeners = [];
  let gameStatus = { state: "idle" };
  const emitGameStatus = (status) => {
    gameStatus = status;
    gameStatusListeners.forEach((listener) => listener(status));
  };
  window.__exitGame = () => emitGameStatus({ state: "idle" });
  window.__copiedText = null;
  window.__serverStatusCalls = 0;
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
    listServers: async () => [
      {
        id: "create-aeronautics",
        name: "Create Aeronautics",
        packId: "create-aeronautics",
        description: "하늘과 기계가 만나는 모드팩",
        server: { host: "server.fri4666.com", port: 25565 },
        minecraftVersion: "1.21.1",
        loader: { kind: "neoforge", version: "21.1.228" }
      }
    ],
    defaultInstanceRoot: async () => "C:\\Bweeep\\instances",
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
      allowed: previewSignedIn && !previewAccessUnavailable && !previewAccessDenied,
      isAdmin: false,
      unavailable: previewAccessUnavailable,
      reason: previewAccessUnavailable ? "로그인 세션을 서버에서 인증하지 못했습니다. 다시 로그인해 주세요." : previewAccessDenied ? "초대 코드가 필요합니다." : previewSignedIn ? "초대 확인 완료" : "로그인이 필요합니다.",
      user: previewSignedIn ? { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null } : undefined
    }),
    login: async () => ({ configured: true, pending: true, user: null, message: "브라우저에서 Discord 로그인을 완료해 주세요." }),
    cancelLogin: async () => ({ cancelled: true, message: "로그인을 취소했습니다. 다시 시도할 수 있습니다." }),
    logout: async () => ({ loggedIn: false, allowed: false, isAdmin: false, reason: "로그아웃했습니다." }),
    redeemInvite: async (code) => {
      if (code !== "BWEEP-123456789ABC-123456789ABC") throw new Error(`초대 코드가 정규화되지 않았습니다: ${code}`);
      return {
        ok: true,
        message: "완료",
        status: { loggedIn: true, allowed: true, isAdmin: false, reason: "허용됨" }
      };
    },
    createInvite: async (maxUses) => ({ code: "BWEEP-123456789ABC-123456789ABC", expiresAt: "2026-12-31", maxUses }),
    serverConnection: async () => ({ host: "server.fri4666.com", port: 25565 }),
    saveServerConnection: async (connection) => connection,
    resetServerConnection: async () => ({ host: "server.fri4666.com", port: 25565 }),
    checkLauncherUpdate: async () => ({ state: "current" }),
    gameStatus: async () => gameStatus,
    launchGame: async () => {
      emitGameStatus({ state: "starting" });
      listeners.forEach((listener) => listener({ kind: "info", message: "Create Aeronautics 동기화 시작", completed: 0, total: 3 }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      listeners.forEach((listener) => listener({ kind: "download", message: "다운로드: mods/create.jar", completed: 0, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "info", message: "준비 완료: mods/create.jar", completed: 1, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "download", message: "다운로드: mods/aeronautics.jar", completed: 1, total: 3, filePath: "mods/aeronautics.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      listeners.forEach((listener) => listener({ kind: "done", message: "완료", completed: 3, total: 3 }));
      emitGameStatus({ state: "running", pid: 4242 });
      return result;
    },
    openPath: async () => "",
    openExternal: async () => undefined,
    copyText: async (value) => { window.__copiedText = value; },
    readyForInvite: async () => null,
    minimizeWindow: () => undefined,
    closeWindow: () => undefined,
    onAuthSession: () => () => {},
    onAuthError: () => () => {},
    onInviteReceived: () => () => {},
    onLauncherUpdate: () => () => {},
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
}, { previewSignedIn: signedIn, previewAccessUnavailable: accessUnavailable, previewAccessDenied: accessDenied });

await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(120);
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

await verifyHover(accessUnavailable ? ".entryRecovery > button:first-child" : accessDenied ? ".entryLogout" : signedIn ? ".launchButton" : ".entryChoices button:first-child", accessUnavailable ? "recovery" : accessDenied ? "invite-screen" : signedIn ? "launch" : "login");
await page.screenshot({ path: accessDenied ? "previews/bweeep-launcher-invite-entry.png" : signedIn ? "previews/bweeep-launcher-flow-ready.png" : "previews/bweeep-launcher-login-main.png" });
if (accessUnavailable) {
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
  interactionChecks.push("server-address-hidden");
  const serverFact = await page.locator(".quickFact").filter({ hasText: "서버 상태" }).innerText();
  if (!serverFact.includes("방금 전") || /\d{1,2}시\s*\d{1,2}분|\d{1,2}:\d{2}/.test(serverFact)) {
    throw new Error(`server checked time is not relative: ${serverFact}`);
  }
  interactionChecks.push("relative-server-time");
  await page.getByRole("button", { name: "설정" }).click();
  await page.waitForTimeout(100);
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
  await page.screenshot({ path: "previews/bweeep-launcher-settings-preview.png" });
  await page.locator(".settingsModal .closeButton").click();
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.getByRole("button", { name: "게임 시작 중" }).waitFor();
  if (!(await page.getByRole("button", { name: "게임 시작 중" }).isDisabled())) throw new Error("launch button was not locked while starting");
  await page.waitForTimeout(480);
  await page.screenshot({ path: "previews/bweeep-launcher-flow-downloading.png" });
  await page.getByRole("button", { name: "게임 중" }).waitFor();
  if (!(await page.getByRole("button", { name: "게임 중" }).isDisabled())) throw new Error("launch button was not locked while running");
  await page.evaluate(() => window.__exitGame());
  await page.getByRole("button", { name: "게임 시작" }).waitFor();
  if (await page.getByRole("button", { name: "게임 시작" }).isDisabled()) throw new Error("launch button did not unlock after exit");
  interactionChecks.push("game-lifecycle-lock");
} else {
  await page.getByRole("button", { name: "Discord로 로그인" }).click();
  await page.getByRole("button", { name: "Discord 로그인 진행 중" }).waitFor();
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
