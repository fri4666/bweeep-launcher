import assert from 'node:assert/strict';
import { verifyPromotionProof } from './verify-promotion-gate.mjs';

const sourceSha = 'a'.repeat(40);
const installerSha256 = 'b'.repeat(64);
const version = '0.1.41';
const manifest = { version, channel: 'stable', arch: 'x64', files: [{ path: 'Bweeep.exe' }, { path: 'same' }], signature: 'candidate-signature' };
const run = { id: 123, path: '.github/workflows/release-validation.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: sourceSha, status: 'completed', conclusion: 'success' };
const receipts = Object.fromEntries(['FreshNSIS', 'LegacyBridge', 'FileBridge'].map((mode) => [mode, {
  receipt: { mode, arch: 'x64', runnerArch: 'X64', phase: 'passed', stagedCandidate: true, sourceSha, finalVersion: version, candidateInstallerSha256: installerSha256, manifestSignature: manifest.signature, verifiedFiles: 2, installer: { sha256: installerSha256 }, initialMainPids: [10], finalMainPids: [20], actualChanged: ['Bweeep.exe'], expectedChanged: ['Bweeep.exe'], unchangedFilesUntouched: 1 },
  verification: { version, arch: 'x64', signatureVerified: true, installedFilesVerified: 2 }
}]));
const arm64 = { installerSha256: 'f'.repeat(64), manifest: { ...manifest, arch: 'arm64', signature: 'arm-candidate-signature' }, receipts: {} };
for (const mode of ['FreshNSIS', 'FileBridge']) {
  arm64.receipts[mode] = structuredClone(receipts[mode]);
  Object.assign(arm64.receipts[mode].receipt, { arch: 'arm64', runnerArch: 'ARM64', candidateInstallerSha256: arm64.installerSha256, manifestSignature: arm64.manifest.signature, installer: { sha256: arm64.installerSha256 } });
  arm64.receipts[mode].verification.arch = 'arm64';
}
const native = { schema: 1, phase: 'passed', version, sourceSha, installerSha256, manifestSignature: manifest.signature, rootProtected: true, protectedUpdateVerified: true, signatureVerified: true, verifiedFiles: 2, normalProfile: true, elevatedBefore: false, elevatedAfter: false, initialMainPid: 30, finalMainPid: 40 };
const input = { version, sourceSha, run, installerSha256, manifest, receipts, native, arm64 };
assert.equal(verifyPromotionProof(input).nativeProtected, true);

for (const [name, mutate] of [
  ['failed run', (value) => { value.run.conclusion = 'failure'; }],
  ['different source', (value) => { value.run.head_sha = 'c'.repeat(40); }],
  ['PR-only evidence', (value) => { value.run.event = 'pull_request'; }],
  ['missing mode', (value) => { delete value.receipts.LegacyBridge; }],
  ['blocked mode', (value) => { value.receipts.LegacyBridge.receipt.phase = 'blocked'; }],
  ['published-first test', (value) => { value.receipts.FileBridge.receipt.stagedCandidate = false; }],
  ['different candidate', (value) => { value.receipts.FileBridge.receipt.candidateInstallerSha256 = 'd'.repeat(64); }],
  ['different manifest', (value) => { value.receipts.FileBridge.receipt.manifestSignature = 'other'; }],
  ['no real restart', (value) => { value.receipts.FileBridge.receipt.finalMainPids = [10]; }],
  ['unsigned runtime', (value) => { value.receipts.FileBridge.verification.signatureVerified = false; }],
  ['unchanged file rewritten', (value) => { value.receipts.FileBridge.receipt.unchangedFilesUntouched = 0; }],
  ['protected observational only', (value) => { value.native.phase = 'not-covered'; }],
  ['different protected candidate', (value) => { value.native.installerSha256 = 'e'.repeat(64); }],
  ['wrong profile', (value) => { value.native.normalProfile = false; }],
  ['elevated restart', (value) => { value.native.elevatedAfter = true; }],
  ['missing ARM64 coverage', (value) => { delete value.arm64; }],
  ['missing ARM64 installation', (value) => { delete value.arm64.receipts.FreshNSIS; }],
  ['failed ARM64 migration', (value) => { value.arm64.receipts.FileBridge.receipt.phase = 'failed'; }],
  ['ARM64 simulated on x64', (value) => { value.arm64.receipts.FileBridge.receipt.runnerArch = 'X64'; }],
  ['wrong ARM64 artifact', (value) => { value.arm64.receipts.FreshNSIS.receipt.installer.sha256 = installerSha256; }],
  ['wrong ARM64 manifest', (value) => { value.arm64.receipts.FileBridge.receipt.manifestSignature = manifest.signature; }]
]) {
  const changed = structuredClone(input);
  mutate(changed);
  assert.throws(() => verifyPromotionProof(changed), { name: 'AssertionError' }, name);
}
console.log('promotion-gate: five native cases accepted; 21 incomplete or mismatched proofs rejected');
