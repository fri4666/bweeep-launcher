import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { UPDATE_CHUNK_SIZE, updatePartCount, verifyFileUpdateManifest } from "../dist/src/main/file-update-manifest.js";
import { isNewerLauncherVersion } from "../dist/src/main/version.js";

const required = [
  ["FreshNSIS", "x64"],
  ["LegacyBridge", "x64"],
  ["FileBridge", "x64"],
  ["FixedFileBridge", "x64"],
  ["FreshNSIS", "arm64"],
  ["FileBridge", "arm64"]
];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function api(endpoint) {
  return JSON.parse(gh(["api", endpoint]));
}

function release(repository, tag) {
  return JSON.parse(gh(["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,publishedAt,targetCommitish,assets"]));
}

function asset(releaseInfo, name) {
  const matches = releaseInfo.assets.filter((item) => item.name === name);
  assert.equal(matches.length, 1, "Expected one release asset: " + name);
  assert.match(matches[0].digest ?? "", /^sha256:[a-f0-9]{64}$/, "Missing digest: " + name);
  assert.ok(matches[0].size > 0, "Empty release asset: " + name);
  return matches[0].digest.slice(7);
}

async function findFiles(directory, filename) {
  const found = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(item, filename));
    else if (entry.name === filename) found.push(item);
  }
  return found;
}

async function downloadManifest(repository, tag, name, output, releaseInfo, publicKey, version, channel, architecture) {
  const directory = path.join(output, tag);
  await fsp.mkdir(directory, { recursive: true });
  gh(["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", directory]);
  const bytes = await fsp.readFile(path.join(directory, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, asset(releaseInfo, name), "Manifest asset changed: " + name);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.channel, channel);
  assert.equal(manifest.arch, architecture);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  verifyFileUpdateManifest(manifest, publicKey, "0.0.0", channel, architecture);
  return { manifest, digest };
}

async function main() {
  const [version, runId, output, betaBuild = "1"] = process.argv.slice(2);
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(betaBuild, /^[1-9]\d*$/, "Beta build must be a positive integer");
  assert.match(runId ?? "", /^[1-9]\d*$/);
  assert.ok(output, "Proof output directory is required");
  const repository = process.env.GITHUB_REPOSITORY;
  const workflowSha = process.env.GITHUB_SHA;
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(workflowSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(process.env.GH_TOKEN, "GitHub read token is required");
  const publicKeyBase64 = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
  assert.ok(publicKeyBase64, "Update public key is required");
  const publicKey = Buffer.from(publicKeyBase64, "base64").toString("utf8");
  const packageJson = JSON.parse(await fsp.readFile("package.json", "utf8"));
  assert.equal(packageJson.version, version);
  const mainSha = api("repos/" + repository + "/commits/main").sha;
  assert.equal(workflowSha, mainSha, "Publisher must run from current main");

  const run = api("repos/" + repository + "/actions/runs/" + runId);
  assert.equal(run.path, ".github/workflows/release-validation.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, mainSha, "Validation used a different source revision");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "Windows validation did not pass");
  const candidateRuns = api("repos/" + repository + "/actions/workflows/release-on-main.yml/runs?head_sha=" + mainSha + "&per_page=100").workflow_runs;
  assert.ok(candidateRuns.some((candidate) => candidate.event === "push" && candidate.head_branch === "main" && candidate.head_sha === mainSha && candidate.status === "completed" && candidate.conclusion === "success"), "Same-main candidate build did not pass");
  const jobs = api("repos/" + repository + "/actions/runs/" + runId + "/jobs?per_page=100").jobs;
  for (const [mode, architecture] of required) {
    const jobName = "nsis-and-update (" + mode + ", " + architecture + ")";
    assert.ok(jobs.some((job) => job.name === jobName && job.conclusion === "success"), "Missing successful job: " + jobName);
  }

  const stableTag = "v" + version;
  const betaVersion = version + "-beta." + betaBuild;
  const betaTag = "v" + betaVersion;
  const stable = release(repository, stableTag);
  const beta = release(repository, betaTag);
  assert.equal(stable.isDraft, true);
  assert.equal(stable.targetCommitish, mainSha);
  assert.equal(beta.isDraft, true, "Beta must still be a draft");
  assert.equal(beta.isPrerelease, true);
  assert.equal(beta.publishedAt, null, "Previously published beta cannot be republished");
  assert.equal(beta.targetCommitish, mainSha);
  const installerSha = {
    x64: asset(stable, "Bweeep-Setup-" + version + ".exe"),
    arm64: asset(stable, "Bweeep-Setup-" + version + "-arm64.exe")
  };
  const betaInstallerSha = {
    x64: asset(beta, "Bweeep-Setup-" + betaVersion + ".exe"),
    arm64: asset(beta, "Bweeep-Setup-" + betaVersion + "-arm64.exe")
  };
  asset(beta, "beta.yml");

  await fsp.mkdir(output, { recursive: true });
  const stableManifests = {};
  const betaManifests = {};
  for (const architecture of ["x64", "arm64"]) {
    const suffix = architecture === "arm64" ? "-arm64" : "";
    stableManifests[architecture] = await downloadManifest(repository, stableTag, "file-update-stable" + suffix + ".json", output, stable, publicKey, version, "stable", architecture);
    betaManifests[architecture] = await downloadManifest(repository, betaTag, "file-update-beta" + suffix + ".json", output, beta, publicKey, betaVersion, "beta", architecture);
  }

  const blobParts = [];
  const blobRoot = "https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates/blobs/";
  for (const { manifest } of Object.values(betaManifests)) {
    for (const file of manifest.files) {
      for (let part = 0; part < updatePartCount(file.packedSize); part++) {
        const suffix = "/part-" + String(part).padStart(4, "0") + ".bin";
        blobParts.push({
          url: blobRoot + file.packedSha256 + suffix,
          size: Math.min(UPDATE_CHUNK_SIZE, file.packedSize - part * UPDATE_CHUNK_SIZE)
        });
      }
    }
  }
  let nextPart = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (nextPart < blobParts.length) {
      const part = blobParts[nextPart++];
      let available = false;
      for (let attempt = 0; attempt < 3 && !available; attempt++) {
        try {
          const response = await fetch(part.url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
          available = response.status === 200 && Number(response.headers.get("content-length")) === part.size;
        } catch { /* Retry a temporary network failure. */ }
        if (!available && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
      assert.ok(available, "Beta update blob is unavailable or has the wrong size: " + part.url);
    }
  }));

  const latestStable = JSON.parse(gh(["release", "view", "--repo", repository, "--json", "tagName"])).tagName.replace(/^v/, "");
  for (const [mode, architecture] of required) {
    const suffix = architecture === "arm64" ? "-arm64" : "";
    const directory = path.join(output, "windows-" + mode + suffix);
    gh(["run", "download", runId, "--repo", repository, "--name", "windows-release-" + mode + suffix, "--dir", directory]);
    const receipts = await findFiles(directory, "receipt.json");
    const verifications = await findFiles(directory, "manifest-verification.json");
    assert.equal(receipts.length, 1, "Ambiguous receipt: " + mode + suffix);
    assert.equal(verifications.length, 1, "Ambiguous manifest verification: " + mode + suffix);
    const receipt = JSON.parse(await fsp.readFile(receipts[0], "utf8"));
    const verification = JSON.parse(await fsp.readFile(verifications[0], "utf8"));
    assert.equal(receipt.mode, mode);
    assert.equal(receipt.arch, architecture);
    assert.equal(receipt.runnerArch?.toLowerCase(), architecture);
    assert.equal(receipt.phase, "passed");
    assert.equal(receipt.stagedCandidate, true);
    assert.equal(receipt.helperTraceEnabled, false);
    assert.equal(receipt.sourceSha, mainSha);
    assert.equal(receipt.finalVersion, version);
    assert.equal(receipt.candidateInstallerSha256, installerSha[architecture]);
    assert.equal(receipt.manifestSignature, stableManifests[architecture].manifest.signature);
    assert.equal(receipt.verifiedFiles, stableManifests[architecture].manifest.files.length);
    assert.equal(verification.signatureVerified, true);
    assert.equal(verification.version, version);
    assert.equal(verification.arch, architecture);
    if (mode === "FileBridge" && architecture === "x64") assert.equal(receipt.baseline, latestStable);
    if (mode === "FixedFileBridge" || (mode === "FileBridge" && architecture === "arm64")) {
      assert.equal(receipt.baseline, betaVersion);
      assert.equal(receipt.installer?.sha256, betaInstallerSha[architecture], "Validated a different beta installer");
    }
  }

  const proof = {
    version: betaVersion,
    sourceSha: mainSha,
    validationRunId: Number(runId),
    architectures: ["x64", "arm64"],
    windowsCases: required.length,
    blobPartsChecked: blobParts.length,
    betaAssetDigests: Object.fromEntries(beta.assets.map((item) => {
      assert.match(item.digest ?? "", /^sha256:[a-f0-9]{64}$/);
      return [item.name, item.digest.slice(7)];
    })),
    betaManifestSha256: Object.fromEntries(Object.entries(betaManifests).map(([architecture, value]) => [architecture, value.digest]))
  };
  await fsp.writeFile(path.join(output, "beta-promotion-gate.json"), JSON.stringify(proof, null, 2));
  console.log("Beta promotion gate passed: " + betaVersion);
}

async function checkDraft() {
  const [proofPath, oldX64Path, oldArm64Path] = process.argv.slice(3);
  assert.ok(proofPath && oldX64Path && oldArm64Path);
  const proof = JSON.parse(await fsp.readFile(proofPath, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(process.env.GH_TOKEN);
  const mainSha = api("repos/" + repository + "/commits/main").sha;
  assert.equal(mainSha, proof.sourceSha, "Main changed after validation");
  const beta = release(repository, "v" + proof.version);
  assert.equal(beta.isDraft, true);
  assert.equal(beta.publishedAt, null);
  assert.equal(beta.targetCommitish, mainSha);
  const digests = Object.fromEntries(beta.assets.map((item) => {
    assert.match(item.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    return [item.name, item.digest.slice(7)];
  }));
  assert.deepEqual(digests, proof.betaAssetDigests, "Beta draft assets changed after review");
  const publicKeyBase64 = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
  assert.ok(publicKeyBase64);
  const publicKey = Buffer.from(publicKeyBase64, "base64").toString("utf8");
  for (const [architecture, file] of [["x64", oldX64Path], ["arm64", oldArm64Path]]) {
    const current = JSON.parse(await fsp.readFile(file, "utf8"));
    verifyFileUpdateManifest(current, publicKey, "0.0.0", "beta", architecture);
    assert.ok(isNewerLauncherVersion(proof.version, current.version), "Current beta channel is not older: " + architecture);
  }
  console.log("Beta draft assets and older channel pointers verified");
}

if (process.argv[2] === "--check-draft") await checkDraft();
else await main();
