import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Packaged Electron windows load the renderer through file://, so assets
  // must resolve relative to renderer/index.html instead of the filesystem root.
  base: "./",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false
  }
});
