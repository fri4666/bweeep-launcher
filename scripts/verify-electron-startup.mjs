import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? root);
const supabaseConfig = JSON.parse(await fs.readFile(path.join(root, "resources", "supabase.example.json"), "utf8"));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-startup-"));
await fs.writeFile(path.join(temp, "supabase-auth.json"), "invalid-encrypted-session", "utf8");
let application;
try {
  application = await electron.launch({
    args: [path.join(root, "scripts", "startup-bootstrap.cjs")],
    env: {
      ...process.env,
      BWEEEP_TEST_APP: target,
      BWEEEP_TEST_DATA: temp,
      BWEEEP_SUPABASE_URL: supabaseConfig.url,
      BWEEEP_SUPABASE_PUBLISHABLE_KEY: supabaseConfig.publishableKey,
      VITE_DEV_SERVER_URL: ""
    }
  });
  const page = await application.firstWindow({ timeout: 15000 });
  await page.waitForLoadState("load");
  await page.waitForFunction(() => document.querySelector("#root")?.textContent.includes("로그인하고 시작하세요"), null, { timeout: 10000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    url: location.href,
    bridge: typeof window.bweeep,
    text: document.querySelector("#root")?.textContent ?? "",
    images: [...document.images].map(image => ({ src: image.src, loaded: image.complete && image.naturalWidth > 0 })),
    windowControls: document.querySelectorAll(".windowControls button").length
  }));
  const diagnostics = await application.evaluate(({ BrowserWindow, safeStorage }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      errors: globalThis.startupErrors,
      menuVisible: window.isMenuBarVisible(),
      hasShadow: window.hasShadow(),
      safeStorageAvailable: safeStorage.isEncryptionAvailable()
    };
  });
  const sessionFiles = await fs.readdir(temp);
  const corruptSessionQuarantined = sessionFiles.some((name) => name.startsWith("supabase-auth.json.corrupt-"));
  console.log(JSON.stringify({ ...state, ...diagnostics, corruptSessionQuarantined }, null, 2));
  await fs.mkdir(path.join(root, "previews"), { recursive: true });
  await page.screenshot({ path: path.join(root, "previews", "electron-startup.png") });
  if (state.bridge !== "object" || !state.text.includes("로그인하고 시작하세요") || state.text.includes("Create Aeronautics") || state.windowControls !== 2 || diagnostics.errors.length || diagnostics.menuVisible || diagnostics.hasShadow || state.images.some(image => !image.loaded) || (diagnostics.safeStorageAvailable && !corruptSessionQuarantined)) {
    throw new Error("Real Electron startup failed");
  }
} finally {
  await application?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
