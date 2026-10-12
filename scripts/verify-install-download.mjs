// The game-file downloader with a stand-in for the network: files arrive
// several at a time but never more than 8, each one is checked, a path listed
// twice is fetched once, a second address is tried when the first fails, and
// a file that cannot be verified fails the batch without leaving a part behind.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { downloadInstallFilesWithSystemNetwork } from "../dist/src/main/system-network.js";

// Under ~/.cache rather than /tmp, which is memory-backed on the dev machine.
await fsp.mkdir(path.join(homedir(), ".cache"), { recursive: true });
const root = await fsp.mkdtemp(path.join(homedir(), ".cache", "bweeep-install-download-check-"));
const sha1 = (bytes) => crypto.createHash("sha1").update(bytes).digest("hex");

// --- Stand-in network -------------------------------------------------------
const bodies = new Map();
const requests = [];
let active = 0;
let maxActive = 0;
const fetcher = async (url) => {
  requests.push(url);
  active += 1;
  maxActive = Math.max(maxActive, active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = bodies.get(url);
    return body ? new Response(body) : new Response(null, { status: 404 });
  } finally {
    active -= 1;
  }
};
const installFile = (dir, name, { served = true, checksum } = {}) => {
  const body = Buffer.from(`content of ${name}`);
  const url = `https://files.test/${dir}/${name}`;
  if (served) bodies.set(url, body);
  return { path: path.join(root, dir, name), urls: [url], size: body.length, checksum: { algorithm: "sha1", value: checksum ?? sha1(body) } };
};
const partsLeft = async (dir) => (await fsp.readdir(path.join(root, dir))).filter((name) => name.endsWith(".bweeep-part"));

try {
  // --- Many files: in parallel, at most 8, all verified ----------------------
  {
    const files = Array.from({ length: 40 }, (_, index) => installFile("many", `file-${index}.bin`));
    const progress = [];
    await downloadInstallFilesWithSystemNetwork(files, (completed, total, filePath, phase) => progress.push({ completed, total, filePath, phase }), fetcher);
    for (const file of files) {
      assert.equal(await fsp.readFile(file.path, "utf8"), `content of ${path.basename(file.path)}`);
    }
    assert.equal(requests.length, 40);
    assert.ok(maxActive > 1, "files are fetched in parallel");
    assert.ok(maxActive <= 8, `at most 8 at once, saw ${maxActive}`);
    assert.deepEqual(await partsLeft("many"), []);
    assert.equal(progress.filter((event) => event.phase === "start").length, 40);
    const done = progress.filter((event) => event.phase === "done").map((event) => event.completed);
    assert.deepEqual(done, Array.from({ length: 40 }, (_, index) => index + 1), "the finished count goes up one by one to the total");
    assert.ok(progress.every((event) => event.total === 40));
    console.log("install-download-parallel=passed");
  }

  // --- The same path twice is one download ----------------------------------
  {
    requests.length = 0;
    const file = installFile("twice", "shared.bin");
    const totals = new Set();
    await downloadInstallFilesWithSystemNetwork([file, { ...file }, installFile("twice", "other.bin")], (_completed, total) => totals.add(total), fetcher);
    assert.equal(requests.filter((url) => url.endsWith("shared.bin")).length, 1);
    assert.deepEqual([...totals], [2]);
    assert.equal(await fsp.readFile(file.path, "utf8"), "content of shared.bin");
    console.log("install-download-duplicate-path=passed");
  }

  // --- A second address is used when the first one fails ----------------------
  {
    const file = installFile("mirror", "library.jar");
    file.urls = ["https://files.test/mirror/missing.jar", ...file.urls];
    await downloadInstallFilesWithSystemNetwork([file], undefined, fetcher);
    assert.equal(await fsp.readFile(file.path, "utf8"), "content of library.jar");
    console.log("install-download-second-address=passed");
  }

  // --- A file that fails its check fails the batch and leaves no part ---------
  {
    const good = Array.from({ length: 12 }, (_, index) => installFile("broken", `good-${index}.bin`));
    const bad = installFile("broken", "bad.bin", { checksum: "0".repeat(40) });
    await assert.rejects(downloadInstallFilesWithSystemNetwork([...good.slice(0, 6), bad, ...good.slice(6)], undefined, fetcher), /다운로드에 실패했습니다: bad\.bin/);
    await assert.rejects(fsp.stat(bad.path), { code: "ENOENT" });
    assert.deepEqual(await partsLeft("broken"), []);
    console.log("install-download-failed-check=passed");
  }

  // --- Only HTTPS addresses are fetched ---------------------------------------
  {
    requests.length = 0;
    const file = { ...installFile("plain", "file.bin"), urls: ["http://files.test/plain/file.bin"] };
    await assert.rejects(downloadInstallFilesWithSystemNetwork([file], undefined, fetcher), /안전한 다운로드 주소가 없습니다/);
    assert.equal(requests.length, 0);
    console.log("install-download-https-only=passed");
  }
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
