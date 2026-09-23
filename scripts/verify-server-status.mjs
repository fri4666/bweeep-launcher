import assert from "node:assert/strict";
import { checkServer } from "../dist/src/main/server-status.js";

const offline = await checkServer({ host: "127.0.0.1", port: 1 });
assert.equal(offline.online, false);
assert.equal(offline.message, "연결 끊김");
assert.equal(offline.latencyMs, undefined);
console.log("server-status-regression=passed");
