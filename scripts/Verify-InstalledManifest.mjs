import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, output, expectedVersion, suppliedUrl, requestedArch = 'x64'] = process.argv.slice(2);
assert.ok(root && output && expectedVersion, 'root, output and version required');
assert.ok(['x64', 'arm64'].includes(requestedArch));
const installed = JSON.parse(await fsp.readFile(path.join(root, 'resources/app/package.json'), 'utf8'));
assert.equal(installed.version, expectedVersion);
const publicKey = await fsp.readFile(path.join(root, 'resources/bweeep-update-public-key.pem'), 'utf8');
assert.equal(createHash('sha256').update(publicKey.replace(/\r\n/g, '\n')).digest('hex'), 'fd477072e06776065e36819e67ddac5ef43381c54a09a61e599a81eeb5262d38', 'Installed verification key changed');
const { verifyFileUpdateManifest } = await import(pathToFileURL(path.join(root, 'resources/app/dist/src/main/file-update-manifest.js')).href);
const manifestUrl = suppliedUrl || `https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates/channels/stable/${requestedArch}.json`;
assert.ok(manifestUrl.startsWith('https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates/'));
const response = await fetch(manifestUrl, { cache: 'no-store' });
assert.equal(response.status, 200);
const manifest = verifyFileUpdateManifest(await response.json(), publicKey, '0.0.0', 'stable', requestedArch);
assert.equal(manifest?.version, expectedVersion);
for (const entry of manifest.files) {
  const filename = path.join(root, ...entry.path.split('/'));
  assert.equal((await fsp.stat(filename)).size, entry.size, entry.path);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  assert.equal(hash.digest('hex'), entry.sha256, entry.path);
}
await fsp.writeFile(path.join(output, 'manifest-verification.json'), JSON.stringify({
  version: manifest.version, arch: manifest.arch, signatureVerified: true, installedFilesVerified: manifest.files.length,
  installedPublicKeyTrust: 'Bootstrap installer SHA-256 pinned by calling workflow', anonymousRequest: true
}, null, 2));
console.log(`signed-installed-files=${manifest.files.length}`);
