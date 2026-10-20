import { selectCatalog } from "./catalog.ts";
import { gameNameTakenMessage, isGameNameTaken, OFFLINE_SERVER } from "./game-name.ts";

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id,
  name: id,
  version: "1",
  minecraftVersion: "26.3",
  java: { majorVersion: 25, component: "java-runtime-epsilon" },
  loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "example.invalid", port: 25565 },
  gameAuth: "yggdrasil",
  files: [{ path: "mods/a.jar", size: 1, sha256: "0".repeat(64), url: "storage://packs/a.jar" }],
  ...extra
});

Deno.test("one broken or offline release does not hide the other servers", () => {
  const { entries, skipped } = selectCatalog([
    { pack_id: "good", manifest: manifest("good"), version: "2" },
    { pack_id: "good", manifest: manifest("good", { name: "older" }), version: "1" },
    { pack_id: "broken", manifest: { id: "broken", files: "nope" }, version: "1" },
    { pack_id: "offline", manifest: manifest("offline", { gameAuth: "offline" }), version: "1" },
    { pack_id: "legacy", manifest: manifest("legacy", { gameAuth: undefined }), version: "1" },
    { pack_id: "test", manifest: manifest("test", { audience: "testers" }), version: "1" }
  ], { testAllowed: false });
  if (entries.map((entry) => entry.manifest.id).join(",") !== "good") throw new Error(`wrong catalog: ${JSON.stringify(entries)}`);
  if (entries[0].version !== "2" || entries[0].manifest.files.length !== 0) throw new Error("the newest release is listed without its file list");
  const reasons = skipped.map((release) => `${release.packId}:${release.reason}`).sort().join(",");
  if (reasons !== "broken:invalid,legacy:offline,offline:offline") throw new Error(`wrong skip reasons: ${reasons}`);
});

Deno.test("testers see test servers", () => {
  const { entries } = selectCatalog([{ pack_id: "test", manifest: manifest("test", { audience: "testers" }), version: "1" }], { testAllowed: true });
  if (entries.length !== 1) throw new Error("a tester must see the test server");
});

Deno.test("name errors are short and name the one-day hold", () => {
  if (!isGameNameTaken({ message: "GAME_NAME_TAKEN" }) || isGameNameTaken({ message: "boom" }) || isGameNameTaken(null)) {
    throw new Error("only GAME_NAME_TAKEN means the name is taken");
  }
  const message = gameNameTakenMessage("seos_py");
  if (!message.includes("seos_py") || !message.includes("하루") || message.includes("예전에 쓴")) {
    throw new Error(`the taken-name message must describe the new rule: ${message}`);
  }
  if (OFFLINE_SERVER.code !== "SERVER_AUTH_UNSUPPORTED" || OFFLINE_SERVER.message.includes("\n")) throw new Error("offline servers get one line");
});
