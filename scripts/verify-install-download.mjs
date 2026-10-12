// The game-file downloader with a stand-in for the network: files arrive
// several at a time but never more than 8, each one is checked, a path listed
// twice is fetched once, a second address is tried when the first fails, and
// a file that cannot be verified fails the batch without leaving a part behind.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { downloadVerified, StallError } from "../dist/src/main/download.js";
import { downloadInstallFilesWithSystemNetwork, withFallbackUrls } from "../dist/src/main/system-network.js";

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

  // --- Stalls, retries and the way around a hung route -------------------------
  const quick = { limits: { headerMs: 80, idleMs: 80, totalMs: 5_000 }, retryDelayMs: 5, cooldownMs: 10_000 };
  const bodyOf = (name) => Buffer.from(`content of ${name}`);
  const never = (signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const events = () => {
    const seen = [];
    return { seen, onEvent: (event) => seen.push(event) };
  };

  // A request that never answers is cut off and the next attempt goes through the direct route.
  {
    const file = installFile("hung", "lib.jar", { served: false });
    const body = bodyOf("lib.jar");
    const { seen, onEvent } = events();
    const system = async (_url, init) => never(init?.signal);
    const direct = async () => new Response(body);
    const startedAt = Date.now();
    await downloadInstallFilesWithSystemNetwork([{ ...file, size: body.length }], undefined, system, { ...quick, directFetcher: direct, onEvent });
    assert.equal(await fsp.readFile(file.path, "utf8"), "content of lib.jar");
    assert.ok(Date.now() - startedAt < 2_000, "gave up on the hung request quickly");
    assert.ok(seen.some((event) => event.type === "stall" && event.phase === "header" && event.file === "lib.jar"));
    assert.ok(seen.some((event) => event.type === "retry" && event.attempt === 2));
    assert.deepEqual(await partsLeft("hung"), []);
    console.log("install-download-hung-request-retried=passed");
  }

  // A fetcher that ignores the abort signal still cannot hold the install.
  {
    const file = installFile("deaf", "lib.jar", { served: false });
    const body = bodyOf("lib.jar");
    const system = () => new Promise(() => undefined);
    await downloadInstallFilesWithSystemNetwork([{ ...file, size: body.length }], undefined, system, { ...quick, directFetcher: async () => new Response(body), onEvent: () => undefined });
    assert.equal(await fsp.readFile(file.path, "utf8"), "content of lib.jar");
    console.log("install-download-ignored-abort-signal=passed");
  }

  // A body that goes quiet half way is cut off and fetched again.
  {
    const body = Buffer.from("0123456789".repeat(10));
    const file = installFile("quiet", "big.bin", { served: false, checksum: sha1(body) });
    const { seen, onEvent } = events();
    let calls = 0;
    const flaky = async (_url, init) => {
      calls += 1;
      if (calls > 1) return new Response(body);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(body.subarray(0, 40));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        }
      }));
    };
    await downloadInstallFilesWithSystemNetwork([{ ...file, size: body.length }], undefined, flaky, { ...quick, onEvent });
    assert.deepEqual(await fsp.readFile(file.path), body);
    assert.equal(calls, 2);
    assert.ok(seen.some((event) => event.type === "stall" && event.phase === "idle"));
    assert.deepEqual(await partsLeft("quiet"), []);
    console.log("install-download-stalled-body-retried=passed");
  }

  // A server hiccup is retried; a missing file is not.
  {
    const file = installFile("hiccup", "lib.jar", { served: false });
    const body = bodyOf("lib.jar");
    let calls = 0;
    const { seen, onEvent } = events();
    await downloadInstallFilesWithSystemNetwork([{ ...file, size: body.length }], undefined, async () => (++calls === 1 ? new Response(null, { status: 503 }) : new Response(body)), { ...quick, onEvent });
    assert.equal(calls, 2);
    assert.ok(seen.some((event) => event.type === "retry" && event.reason === "HTTP 503"));

    const missing = installFile("hiccup", "gone.jar", { served: false });
    let missingCalls = 0;
    await assert.rejects(downloadInstallFilesWithSystemNetwork([missing], undefined, async () => { missingCalls += 1; return new Response(null, { status: 404 }); }, { ...quick, onEvent: () => undefined }), /다운로드에 실패했습니다: gone\.jar/);
    assert.equal(missingCalls, 1, "a 404 is not retried");
    assert.deepEqual(await partsLeft("hiccup"), []);
    console.log("install-download-retry-rules=passed");
  }

  // Failures lower how many run at once; eight failing together cost one step.
  {
    const files = Array.from({ length: 40 }, (_, index) => installFile("drop", `file-${index}.bin`));
    const failedOnce = new Set();
    const limits = [];
    let active = 0;
    let started = 0;
    let dropped = false;
    const settledActive = [];
    const congested = async (url) => {
      started += 1;
      if (dropped && started > 20) settledActive.push(active + 1);
      active += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (failedOnce.size < 8 && !failedOnce.has(url)) {
          failedOnce.add(url);
          return new Response(null, { status: 503 });
        }
        return new Response(bodies.get(url));
      } finally {
        active -= 1;
      }
    };
    await downloadInstallFilesWithSystemNetwork(files, undefined, congested, {
      ...quick,
      onEvent: (event) => {
        if (event.type === "concurrency") {
          limits.push(event.limit);
          dropped = true;
        }
      }
    });
    assert.deepEqual(limits, [4], "one step down, however many requests failed at once");
    assert.ok(settledActive.length > 0 && Math.max(...settledActive) <= 4, `at most 4 at once afterwards, saw ${Math.max(...settledActive)}`);
    for (const file of files) assert.ok(await fsp.stat(file.path));

    const again = Array.from({ length: 24 }, (_, index) => installFile("floor", `file-${index}.bin`));
    const stepped = [];
    const failedAddresses = new Set();
    await downloadInstallFilesWithSystemNetwork(again, undefined, async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The first twelve addresses fail once each; their retries then succeed.
      if (failedAddresses.size < 12 && !failedAddresses.has(url)) {
        failedAddresses.add(url);
        return new Response(null, { status: 503 });
      }
      return new Response(bodies.get(url));
    }, { ...quick, cooldownMs: 0, onEvent: (event) => event.type === "concurrency" && stepped.push(event.limit) });
    assert.deepEqual(stepped, [4, 2], "keeps stepping down but never below 2");
    console.log("install-download-concurrency-drops=passed");
  }

  // The Fabric libraries that Maven Central also holds get it as a second address.
  {
    const fabricUrl = "https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar";
    assert.deepEqual(withFallbackUrls({ urls: [fabricUrl], size: 10 }), [fabricUrl, "https://repo1.maven.org/maven2/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar"]);
    assert.equal(withFallbackUrls({ urls: ["https://maven.fabricmc.net/net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar"], checksum: { algorithm: "sha1", value: "a".repeat(40) } }).length, 2);
    assert.equal(withFallbackUrls({ urls: ["https://maven.fabricmc.net/net/fabricmc/intermediary/1.21.1/intermediary-1.21.1.jar"], size: 10 }).length, 1, "only artifacts Maven Central is known to hold");
    assert.equal(withFallbackUrls({ urls: [fabricUrl] }).length, 1, "nothing to check the second address against");
    assert.equal(withFallbackUrls({ urls: ["https://example.test/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar"], size: 10 }).length, 1, "other hosts are left alone");

    const file = { path: path.join(root, "mirror2", "asm-9.10.1.jar"), urls: [fabricUrl], size: bodyOf("asm").length, checksum: { algorithm: "sha1", value: sha1(bodyOf("asm")) } };
    const asked = [];
    const { seen, onEvent } = events();
    await downloadInstallFilesWithSystemNetwork([file], undefined, async (url, init) => {
      asked.push(new URL(url).hostname);
      if (url.startsWith("https://maven.fabricmc.net/")) return never(init?.signal);
      return new Response(bodyOf("asm"));
    }, { ...quick, onEvent });
    assert.equal(await fsp.readFile(file.path, "utf8"), "content of asm");
    assert.deepEqual(asked, ["maven.fabricmc.net", "maven.fabricmc.net", "repo1.maven.org"], "two tries on the blocked host, then Maven Central");
    assert.ok(seen.filter((event) => event.type === "stall").length === 2);

    // The second address still has to match the checksum.
    const wrong = { ...file, path: path.join(root, "mirror2", "asm-wrong.jar"), checksum: { algorithm: "sha1", value: "0".repeat(40) } };
    await assert.rejects(downloadInstallFilesWithSystemNetwork([wrong], undefined, async () => new Response(bodyOf("asm")), { ...quick, onEvent: () => undefined }), /다운로드에 실패했습니다/);
    await assert.rejects(fsp.stat(wrong.path), { code: "ENOENT" });
    console.log("install-download-fallback-address=passed");
  }

  // A big file moves the counter while it downloads.
  {
    const body = Buffer.alloc(4_000, 7);
    const file = { ...installFile("progress", "big.bin", { served: false }), size: body.length, checksum: { algorithm: "sha1", value: sha1(body) } };
    const slow = async () => new Response(new ReadableStream({
      async start(controller) {
        for (let index = 0; index < 4; index += 1) {
          controller.enqueue(body.subarray(index * 1_000, (index + 1) * 1_000));
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        controller.close();
      }
    }));
    const reports = [];
    await downloadInstallFilesWithSystemNetwork([file, installFile("progress", "other.bin")], (completed, total, _path, phase) => reports.push({ completed, total, phase }), async (url) => (url.endsWith("big.bin") ? slow() : new Response(bodies.get(url))), { ...quick, limits: { headerMs: 2_000, idleMs: 2_000, totalMs: 10_000 }, onEvent: () => undefined });
    const partial = reports.filter((report) => report.phase === "bytes" && report.completed % 1 !== 0);
    assert.ok(partial.length > 0, "a fractional count shows the file coming in");
    assert.ok(reports.every((report) => report.completed <= report.total));
    assert.equal(reports.at(-1).completed, 2);
    console.log("install-download-byte-progress=passed");
  }

  // The modpack path stops waiting on a silent connection too, then tries the direct route.
  {
    const body = Buffer.from("mod bytes ".repeat(20));
    const target = path.join(root, "mods", "silent.jar");
    const retries = [];
    await downloadVerified({ url: "https://files.test/silent.jar", target, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") }, {
      fetch: async (_url, init) => never(init?.signal),
      fallbackFetch: async () => new Response(body),
      tries: 2,
      retryDelayMs: 5,
      limits: { headerMs: 80, idleMs: 80, totalMs: 5_000 },
      onRetry: (attempt, error) => retries.push({ attempt, stall: error instanceof StallError })
    });
    assert.deepEqual(await fsp.readFile(target), body);
    assert.deepEqual(retries, [{ attempt: 2, stall: true }]);
    assert.deepEqual(await partsLeft("mods").catch(() => []), []);
    console.log("modpack-download-stall-direct-route=passed");
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
