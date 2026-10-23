import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled NSIS decoder supports BCJ/BCJ2 but silently skips ARM64-filtered
// files. See https://github.com/electron-userland/electron-builder/issues/9983.
export function inspectNsisCodecs(listing) {
  const entries = listing.split(/\r?\n\r?\n/).map((block) => Object.fromEntries(block.split(/\r?\n/).filter((line) => line.includes(' = ')).map((line) => {
    const index = line.indexOf(' = ');
    return [line.slice(0, index), line.slice(index + 3)];
  }))).filter((entry) => entry.Path && entry.Size !== undefined && entry.Method);
  assert.ok(entries.length > 0, 'Embedded application archive contains no readable files');
  const supported = new Set(['Copy', 'LZMA', 'LZMA2', 'BCJ', 'BCJ2']);
  const unsupported = entries.filter((entry) => entry.Method.split(' ').some((codec) => !supported.has(codec.split(':')[0]))).map((entry) => ({ path: entry.Path, method: entry.Method }));
  return { files: entries.length, methods: [...new Set(entries.map((entry) => entry.Method))].sort(), unsupported };
}

async function main() {
  const [installer, architecture, output, sevenZip = '7z'] = process.argv.slice(2);
  assert.ok(path.isAbsolute(installer) && path.isAbsolute(output), 'Absolute installer and owned proof-directory paths required');
  assert.ok(['x64', 'arm64'].includes(architecture));
  await fsp.mkdir(output, { recursive: true });
  const archiveName = `app-${architecture === 'x64' ? '64' : 'arm64'}.7z`;
  const archive = path.join(output, archiveName);
  assert.equal(await fsp.stat(archive).then(() => true, () => false), false, 'Refuse to overwrite an existing proof archive');
  // Extract the embedded archive as data; neither installer nor payload runs.
  execFileSync(sevenZip, ['e', '-y', '-o' + output, installer, '$PLUGINSDIR/' + archiveName], { stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = execFileSync(sevenZip, ['l', '-slt', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const result = inspectNsisCodecs(listing);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
  const proof = { architecture, installerSha256: hash.digest('hex'), ...result, passed: result.unsupported.length === 0 };
  await fsp.writeFile(path.join(output, 'nsis-codec-verification.json'), JSON.stringify(proof, null, 2));
  assert.equal(result.unsupported.length, 0, 'NSIS payload uses codecs its install-time decoder cannot read: ' + result.unsupported.map((entry) => entry.path).join(', '));
  console.log(`nsis-codecs=${architecture}: ${result.files} files use supported codecs`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
