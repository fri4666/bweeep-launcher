import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(() => {
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
      loggedIn: true,
      allowed: true,
      isAdmin: false,
      reason: "초대 확인 완료",
      user: { id: "1", username: "bweeep", globalName: "붸에엡", avatarUrl: null, provider: "discord" }
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
});

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(120);
await page.screenshot({ path: "previews/bweeep-launcher-flow-ready.png" });
await page.getByRole("button", { name: "업데이트 후 시작" }).click();
await page.waitForTimeout(480);
await page.screenshot({ path: "previews/bweeep-launcher-flow-downloading.png" });

console.log(JSON.stringify({
  bodyHasContent: (await page.locator("body").innerText()).trim().length > 0,
  hasErrorOverlay: await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count() > 0,
  errors
}));

await browser.close();
