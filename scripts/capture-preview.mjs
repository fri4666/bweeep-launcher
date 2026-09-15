import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
const signedIn = process.env.BWEEP_PREVIEW_SIGNED_IN !== "false";
const accessUnavailable = process.env.BWEEP_PREVIEW_ACCESS_UNAVAILABLE === "true";
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({ previewSignedIn, previewAccessUnavailable }) => {
  const listeners = [];
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
    serverStatus: async () => ({
      online: true,
      host: "server.fri4666.com",
      port: 25565,
      latencyMs: 18,
      message: "서버 연결 가능"
    }),
    accessStatus: async () => ({
      loggedIn: previewSignedIn,
      allowed: previewSignedIn && !previewAccessUnavailable,
      isAdmin: false,
      unavailable: previewAccessUnavailable,
      reason: previewAccessUnavailable ? "로그인 세션을 서버에서 인증하지 못했습니다. 다시 로그인해 주세요." : previewSignedIn ? "초대 확인 완료" : "초대 코드가 필요합니다.",
      user: previewSignedIn ? { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null, provider: "discord" } : undefined
    }),
    login: async () => ({ configured: true, user: null }),
    logout: async () => ({ loggedIn: false, allowed: false, isAdmin: false, reason: "로그아웃했습니다." }),
    redeemInvite: async () => ({
      ok: true,
      message: "완료",
      status: { loggedIn: true, allowed: true, isAdmin: false, reason: "허용됨" }
    }),
    createInvite: async () => ({ code: "ABC123", expiresAt: "2026-12-31" }),
    readyForInvite: async () => null,
    serverConnection: async () => ({ host: "server.fri4666.com", port: 25565 }),
    saveServerConnection: async (connection) => connection,
    resetServerConnection: async () => ({ host: "server.fri4666.com", port: 25565 }),
    checkLauncherUpdate: async () => ({ state: "current" }),
    launchGame: async () => {
      listeners.forEach((listener) => listener({ kind: "info", message: "Create Aeronautics 동기화 시작", completed: 0, total: 3 }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      listeners.forEach((listener) => listener({ kind: "download", message: "다운로드: mods/create.jar", completed: 0, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "info", message: "준비 완료: mods/create.jar", completed: 1, total: 3, filePath: "mods/create.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      listeners.forEach((listener) => listener({ kind: "download", message: "다운로드: mods/aeronautics.jar", completed: 1, total: 3, filePath: "mods/aeronautics.jar" }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      listeners.forEach((listener) => listener({ kind: "done", message: "완료", completed: 3, total: 3 }));
      return result;
    },
    openPath: async () => "",
    openExternal: async () => undefined,
    minimizeWindow: () => undefined,
    closeWindow: () => undefined,
    onAuthSession: () => () => {},
    onAuthError: () => () => {},
    onInviteCode: () => () => {},
    onProgress: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };
}, { previewSignedIn: signedIn, previewAccessUnavailable: accessUnavailable });

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
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

await verifyHover(accessUnavailable ? ".entryRecovery > button:first-child" : signedIn ? ".launchButton" : ".entryChoices button:first-child", accessUnavailable ? "recovery" : signedIn ? "launch" : "login");
await page.screenshot({ path: signedIn ? "previews/bweeep-launcher-flow-ready.png" : "previews/bweeep-launcher-login-main.png" });
if (accessUnavailable) {
  if (await page.getByRole("button", { name: "다시 확인" }).count() !== 1) throw new Error("access recovery action is missing");
  await page.screenshot({ path: "previews/bweeep-launcher-access-recovery.png" });
} else if (signedIn) {
  await page.getByRole("button", { name: "설정" }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: "previews/bweeep-launcher-settings-preview.png" });
  await page.locator(".settingsModal .closeButton").click();
  await page.getByRole("button", { name: "게임 시작" }).click();
  await page.waitForTimeout(480);
  await page.screenshot({ path: "previews/bweeep-launcher-flow-downloading.png" });
} else {
  await page.screenshot({ path: "previews/bweeep-launcher-login-preview.png" });
}

console.log(JSON.stringify({
  bodyHasContent: (await page.locator("body").innerText()).trim().length > 0,
  hasErrorOverlay: await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count() > 0,
  interactionChecks,
  errors
}));

await browser.close();
