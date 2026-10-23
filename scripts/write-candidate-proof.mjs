import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const packageJson = JSON.parse(await fsp.readFile('package.json', 'utf8'));
const version = packageJson.version;
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
const betaVersion = `${version}-beta.1`;
const builds = [];
for (const { directory, buildVersion, architecture, manifestName, proofName } of [
  { directory: 'release-installer', buildVersion: version, architecture: 'x64', manifestName: 'file-update-stable.json', proofName: 'stable-x64' },
  { directory: 'release-installer-beta', buildVersion: betaVersion, architecture: 'x64', manifestName: 'file-update-beta.json', proofName: 'beta-x64' },
  { directory: 'release-installer-arm64', buildVersion: version, architecture: 'arm64', manifestName: 'file-update-stable-arm64.json', proofName: 'stable-arm64' },
  { directory: 'release-installer-beta-arm64', buildVersion: betaVersion, architecture: 'arm64', manifestName: 'file-update-beta-arm64.json', proofName: 'beta-arm64' }
]) {
  const installerPath = path.join(directory, `Bweeep-Setup-${buildVersion}${architecture === 'arm64' ? '-arm64' : ''}.exe`);
  const sha = createHash('sha256');
  for await (const chunk of fs.createReadStream(installerPath)) sha.update(chunk);
  const installerSha256 = sha.digest('hex');
  const manifestPath = path.join(directory, manifestName);
  const manifestBytes = await fsp.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, buildVersion);
  assert.equal(manifest.arch, architecture);
  assert.ok(manifest.signature && manifest.files.length > 0);
  const codecProof = JSON.parse(await fsp.readFile(path.join('candidate-proof', proofName, 'nsis-codec-verification.json'), 'utf8'));
  assert.equal(codecProof.passed, true);
  assert.equal(codecProof.installerSha256, installerSha256);
  builds.push({ version: buildVersion, architecture, installerPath, installerSha256, installerBytes: (await fsp.stat(installerPath)).size, manifestPath, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), manifestSignature: manifest.signature, files: manifest.files.length, codecProof });
}
await fsp.mkdir('candidate-proof', { recursive: true });
await fsp.writeFile('candidate-proof/candidate-proof.json', JSON.stringify({ schema: 1, version, betaVersion, sourceSha: process.env.GITHUB_SHA, workflowRunId: process.env.GITHUB_RUN_ID, archivesOnly: true, publishedChannels: false, githubReleasePublished: false, builds }, null, 2));
console.log(`candidate-proof=${version}: four exact installers recorded; channels remain unpublished`);
