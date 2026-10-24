import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { mergeConfig } from "vite";
import config from "../vite.config";

const launcherVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;

// Isolated review server. WSL mount paths need polling; shared dependencies
// need their real path allowed so the bundled Pretendard font can be previewed.
export default mergeConfig(config, {
  plugins: [{
    name: "isolated-design-preview",
    configureServer(server) {
      server.middlewares.use("/__design_bridge.js", (_request, response) => {
        const source = readFileSync(resolve("scripts/capture-preview.mjs"), "utf8");
        const start = source.indexOf("await page.addInitScript(");
        const end = source.indexOf("\nawait page.goto(", start);
        const fixture = source.slice(start, end)
          .replace("await page.addInitScript(", "(")
          .replace("\n}, { previewSignedIn:", "\n})({ previewSignedIn:")
          // Review-only pacing lets the designer inspect the existing stages.
          // Counts and stage names still come from the original fixture.
          .replace(/setTimeout\(resolve, (90|300|600)\)/g, "setTimeout(resolve, location.search.includes('launch-flow') ? $1 * 8 : $1)");
        const flags = "const signedIn = !location.search.includes('signed-out'), memberMode = true; const accessUnavailable = false, accessDenied = false, catalogUnavailable = false, testChannelDenied = false, whatsNewMode = false, patchNotesOffline = false, serverOffline = false, serverSleeping = false, serverClosed = false, authOutage = false, moveAndModsMode = false;";
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        const noticeFixture = "if (new URLSearchParams(location.search).has('notice')) window.__notices = [{ id: 'design-notice', text: '새로운 서버 소식과 안내를\\n이곳에서 확인할 수 있어요.', at: '2026-10-19T09:00:00Z', target: null }];";
        response.end(flags + fixture + noticeFixture + `\nwindow.bweeep.launcherVersion = async () => ${JSON.stringify(launcherVersion)}; document.title = '붸에엡 디자인 미리보기 · 샘플 데이터';`);
      });
    },
    transformIndexHtml(html, context) {
      if (!context.originalUrl?.includes("design-preview")) return html;
      return [{ tag: "script", attrs: { src: "/__design_bridge.js" }, injectTo: "head-prepend" }];
    }
  }],
  server: {
    host: "127.0.0.1",
    port: 5193,
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
    fs: { allow: [process.cwd(), realpathSync(resolve("node_modules"))] }
  }
});
