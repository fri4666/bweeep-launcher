import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The packaged renderer runs only its own bundled scripts. Images may also come
// from Discord avatars and Modrinth mod icons. The dev server is left without
// it because React's hot reload needs inline scripts.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://cdn.modrinth.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join("; ");

function contentSecurityPolicyMeta(): Plugin {
  return {
    name: "bweeep-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy }, injectTo: "head-prepend" }]
  };
}

export default defineConfig({
  // Packaged Electron windows load the renderer through file://, so assets
  // must resolve relative to renderer/index.html instead of the filesystem root.
  base: "./",
  plugins: [react(), contentSecurityPolicyMeta()],
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false
  }
});
