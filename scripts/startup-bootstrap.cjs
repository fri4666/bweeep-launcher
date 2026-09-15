const { app } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
app.setPath("userData", process.env.BWEEEP_TEST_DATA);
app.setAsDefaultProtocolClient = () => true;
globalThis.startupErrors = [];
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => globalThis.startupErrors.push("preload: " + error.message));
  contents.on("console-message", (_event, details) => {
    if (details.level === "error" || details.level === 3) globalThis.startupErrors.push(details.message);
  });
  contents.on("did-fail-load", (_event, code, description) => globalThis.startupErrors.push("load: " + code + " " + description));
});
app.on("browser-window-created", (_event, window) => window.hide());
import(pathToFileURL(path.join(process.env.BWEEEP_TEST_APP, "dist/src/main/index.js")).href).catch(error => {
  globalThis.startupErrors.push("main: " + error.message);
  console.error(error);
});
