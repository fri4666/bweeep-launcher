import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modes = ['FreshNSIS', 'LegacyBridge', 'FileBridge'];
const armModes = ['FreshNSIS', 'FileBridge'];
const proofAsset = 'native-protected-validation.json';

function verifyArchitectureProof({ architecture, requiredModes, version, sourceSha, installerSha256, manifest, receipts }) {
  assert.match(installerSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.version, version);
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.arch, architecture);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.equal(typeof manifest.signature, 'string');
  for (const mode of requiredModes) {
    const evidence = receipts[mode];
    assert.ok(evidence, `Missing ${mode} evidence`);
    const { receipt, verification } = evidence;
    assert.equal(receipt.mode, mode);
    assert.equal(receipt.arch, architecture);
    assert.equal(receipt.runnerArch?.toLowerCase(), architecture, `${mode} was not tested on a native ${architecture} runner`);
    assert.equal(receipt.phase, 'passed', `${mode} is not a completed actual pass`);
    assert.equal(receipt.stagedCandidate, true, `${mode} did not test before channel publication`);
    assert.equal(receipt.sourceSha, sourceSha);
    assert.equal(receipt.finalVersion, version);
    assert.equal(receipt.candidateInstallerSha256, installerSha256);
    assert.equal(receipt.manifestSignature, manifest.signature, `${mode} tested a different signed manifest`);
    assert.equal(receipt.verifiedFiles, manifest.files.length);
    assert.equal(verification.version, version);
    assert.equal(verification.arch, architecture);
    assert.equal(verification.signatureVerified, true);
    assert.equal(verification.installedFilesVerified, manifest.files.length);
    if (mode === 'FreshNSIS') assert.equal(receipt.installer.sha256, installerSha256);
    else {
      assert.equal(receipt.probe?.targetVersion, version, `${mode} lacks the isolated candidate acknowledgement`);
      assert.equal(receipt.probe?.arch, architecture);
      assert.equal(receipt.probe?.signatureBypass, false);
      assert.equal(receipt.probe?.helperTraceEnabled, false, 'An instrumented helper cannot qualify a release');
      assert.ok(receipt.initialMainPids?.length > 0, `${mode} lacks the original application process`);
      assert.ok(receipt.finalMainPids?.length > 0, `${mode} lacks the restarted application process`);
      assert.ok(receipt.finalMainPids.every((pid) => !receipt.initialMainPids.includes(pid)), `${mode} did not restart`);
    }
    if (mode === 'FileBridge') {
      assert.ok(Array.isArray(receipt.actualChanged) && receipt.actualChanged.length > 0);
      assert.deepEqual([...receipt.actualChanged].sort(), [...receipt.expectedChanged].sort());
      assert.equal(receipt.unchangedFilesUntouched + receipt.actualChanged.length, manifest.files.length);
    }
  }
}

// Both published architectures need actual passes. A successful workflow
// containing blocked or observational receipts is insufficient.
export function verifyPromotionProof({ version, sourceSha, run, installerSha256, manifest, receipts, native, arm64 }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(run.path, '.github/workflows/release-validation.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, sourceSha, 'Validation ran against a different source revision');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success', 'Installation/update validation did not pass');
  verifyArchitectureProof({ architecture: 'x64', requiredModes: modes, version, sourceSha, installerSha256, manifest, receipts });
  assert.ok(arm64, 'ARM64 publication requires native installation and file-update evidence');
  verifyArchitectureProof({ ...arm64, architecture: 'arm64', requiredModes: armModes, version, sourceSha });
  assert.equal(native.schema, 1);
  assert.equal(native.phase, 'passed', 'The actual protected-folder update has not passed');
  assert.equal(native.version, version);
  assert.equal(native.sourceSha, sourceSha);
  assert.equal(native.installerSha256, installerSha256);
  assert.equal(native.manifestSignature, manifest.signature);
  assert.equal(native.rootProtected, true);
  assert.equal(native.protectedUpdateVerified, true);
  assert.equal(native.signatureVerified, true);
  assert.equal(native.verifiedFiles, manifest.files.length);
  assert.equal(native.normalProfile, true);
  assert.equal(native.elevatedBefore, false);
  assert.equal(native.elevatedAfter, false);
  assert.ok(Number.isSafeInteger(native.initialMainPid) && native.initialMainPid > 0);
  assert.ok(Number.isSafeInteger(native.finalMainPid) && native.finalMainPid > 0);
  assert.notEqual(native.initialMainPid, native.finalMainPid);
  return { version, sourceSha, installerSha256, arm64InstallerSha256: arm64.installerSha256, validationRunId: run.id, modes, armModes, architectures: ['x64', 'arm64'], nativeProtected: true };
}

async function main() {
  const [version, runId, output] = process.argv.slice(2);
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(runId ?? '', /^[1-9]\d*$/);
  assert.ok(output, 'Evidence output directory is required');
  const repository = process.env.GITHUB_REPOSITORY;
  const sourceSha = process.env.GITHUB_SHA;
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(process.env.GH_TOKEN, 'GitHub read token is required');
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const api = (endpoint) => JSON.parse(gh(['api', endpoint]));
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  const release = JSON.parse(gh(['release', 'view', `v${version}`, '--repo', repository, '--json', 'isDraft,publishedAt,targetCommitish,assets']));
  assert.equal(release.isDraft, true, 'The candidate must still be a draft while it is validated');
  assert.equal(release.targetCommitish, sourceSha, 'Candidate was built from a different source revision');
  const asset = release.assets.filter((entry) => entry.name === `Bweeep-Setup-${version}.exe`);
  assert.equal(asset.length, 1);
  assert.match(asset[0].digest ?? '', /^sha256:[a-f0-9]{64}$/);
  const installerSha256 = asset[0].digest.slice(7);
  const armAsset = release.assets.filter((entry) => entry.name === `Bweeep-Setup-${version}-arm64.exe`);
  assert.equal(armAsset.length, 1, 'Exactly one reviewed ARM64 installer is required');
  assert.match(armAsset[0].digest ?? '', /^sha256:[a-f0-9]{64}$/);
  await fsp.mkdir(output, { recursive: true });
  gh(['release', 'download', `v${version}`, '--repo', repository, '--dir', output, '--pattern', 'file-update-stable.json', '--pattern', 'file-update-stable-arm64.json', '--pattern', proofAsset]);
  const manifestBytes = await fsp.readFile(path.join(output, 'file-update-stable.json'));
  const manifest = JSON.parse(manifestBytes);
  const native = JSON.parse(await fsp.readFile(path.join(output, proofAsset), 'utf8'));
  const armManifestBytes = await fsp.readFile(path.join(output, 'file-update-stable-arm64.json'));
  const arm64 = { installerSha256: armAsset[0].digest.slice(7), manifest: JSON.parse(armManifestBytes), receipts: {} };
  const receipts = {};
  async function findFiles(directory, filename) {
    const matches = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) matches.push(...await findFiles(path.join(directory, entry.name), filename));
      else if (entry.name === filename) matches.push(path.join(directory, entry.name));
    }
    return matches;
  }
  for (const { mode, architecture } of [...modes.map(mode => ({ mode, architecture: 'x64' })), ...armModes.map(mode => ({ mode, architecture: 'arm64' }))]) {
    const suffix = architecture === 'arm64' ? '-arm64' : '';
    const directory = path.join(output, mode + suffix);
    gh(['run', 'download', runId, '--repo', repository, '--name', `windows-release-${mode}${suffix}`, '--dir', directory]);
    const receiptFiles = await findFiles(directory, 'receipt.json');
    const verificationFiles = await findFiles(directory, 'manifest-verification.json');
    assert.equal(receiptFiles.length, 1, `Ambiguous ${mode} receipts`);
    assert.equal(verificationFiles.length, 1, `Ambiguous ${mode} manifest verification`);
    (architecture === 'arm64' ? arm64.receipts : receipts)[mode] = {
      receipt: JSON.parse(await fsp.readFile(receiptFiles[0], 'utf8')),
      verification: JSON.parse(await fsp.readFile(verificationFiles[0], 'utf8'))
    };
  }
  const result = verifyPromotionProof({ version, sourceSha, run, installerSha256, manifest, receipts, native, arm64 });
  result.manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  result.arm64ManifestSha256 = createHash('sha256').update(armManifestBytes).digest('hex');
  result.draftAssetDigests = Object.fromEntries(release.assets.map((entry) => {
    assert.match(entry.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Draft asset lacks SHA-256: ${entry.name}`);
    return [entry.name, entry.digest.slice(7)];
  }));
  await fsp.writeFile(path.join(output, 'promotion-gate.json'), JSON.stringify(result, null, 2));
  console.log(`Release gate passed for ${version} (${sourceSha})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
