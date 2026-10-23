import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const [filename, version, publicKeyFile, output, suppliedSha = '', digestSource = 'signed-archive', requestedArch = 'x64'] = process.argv.slice(2);
const optionalSha = suppliedSha === '-' ? '' : suppliedSha;
assert.ok(filename && output && publicKeyFile);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(['x64', 'arm64'].includes(requestedArch));
if (optionalSha) assert.match(optionalSha, /^[a-f0-9]{64}$/);
const keyBytes = Buffer.from((await fsp.readFile(publicKeyFile, 'utf8')).replace(/\r\n/g, '\n'));
const keySha256 = createHash('sha256').update(keyBytes).digest('hex');
assert.equal(keySha256, 'fd477072e06776065e36819e67ddac5ef43381c54a09a61e599a81eeb5262d38', 'Verification key changed');
const storageRoot = 'https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates';
const archiveUrl = `${storageRoot}/installers/${version}/${requestedArch}.json`;
const response = await fetch(archiveUrl, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
assert.equal(response.status, 200, 'Signed installer archive is unavailable');
const manifest = await response.json();
const { schema, arch, size, sha256, chunkSize, chunks, signature } = manifest;
assert.equal(schema, 1); assert.equal(manifest.version, version); assert.equal(arch, requestedArch);
assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 2 * 1024 ** 3);
assert.match(sha256, /^[a-f0-9]{64}$/);
assert.equal(chunkSize, 5 * 1024 * 1024);
assert.ok(Number.isSafeInteger(chunks) && chunks === Math.ceil(size / chunkSize));
assert.equal(typeof signature, 'string');
const payload = { schema, version, arch, size, sha256, chunkSize, chunks };
assert.equal(verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(keyBytes), Buffer.from(signature, 'base64')), true, 'Installer signature invalid');
if (optionalSha) assert.equal(sha256, optionalSha, 'Reviewed/GitHub digest differs from signed archive');

const temporary = `${filename}.part`;
const hash = createHash('sha256');
let handle;
let received = 0;
try {
  handle = await fsp.open(temporary, 'w');
  for (let index = 0; index < chunks; index++) {
    const url = `${storageRoot}/installers/${version}/${arch}/${sha256}/part-${String(index).padStart(4, '0')}.bin`;
    const part = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.equal(part.status, 200, `Installer part ${index} unavailable`);
    const expected = Math.min(chunkSize, size - received);
    assert.ok(part.body, 'Installer part body missing');
    const reader = part.body.getReader();
    const buffers = [];
    let partReceived = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        partReceived += next.value.byteLength;
        assert.ok(partReceived <= expected, `Installer part ${index} exceeds signed size`);
        buffers.push(Buffer.from(next.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    assert.equal(partReceived, expected, `Installer part ${index} size mismatch`);
    const data = Buffer.concat(buffers, partReceived);
    let offset = 0;
    while (offset < data.length) {
      const written = await handle.write(data, offset, data.length - offset);
      assert.ok(written.bytesWritten > 0);
      offset += written.bytesWritten;
    }
    hash.update(data); received += data.length;
    console.log(`archive-part=${index + 1}/${chunks}`);
  }
  assert.equal(received, size); assert.equal(hash.digest('hex'), sha256, 'Reconstructed installer hash mismatch');
  await handle.close(); handle = null;
  await fsp.rename(temporary, filename);
} finally {
  await handle?.close();
  await fsp.rm(temporary, { force: true });
}
await fsp.writeFile(path.join(output, 'installer-download.json'), JSON.stringify({
  version, arch, bytes: received, sha256, chunks, signatureVerified: true,
  verificationKeySha256: keySha256, source: archiveUrl, anonymousParts: true,
  additionalDigestSource: optionalSha ? digestSource : null,
  additionalDigestVerified: Boolean(optionalSha), installerExecuted: false
}, null, 2));
