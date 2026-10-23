import assert from 'node:assert/strict';
import { inspectNsisCodecs } from './verify-nsis-codecs.mjs';

// Actual method formats from the failed ARM64 installer, including the x64
// helper's supported multi-stream BCJ2 format that must not be rejected.
const listing = `Path = Bweeep.exe
Size = 226389504
Method = ARM64 LZMA2:20

Path = resources/elevate.exe
Size = 123456
Method = BCJ2 LZMA2:20 LZMA:20:lc0:lp2 LZMA:20:lc0:lp2

Path = resources/app/package.json
Size = 1234
Method = LZMA2:20
`;
const broken = inspectNsisCodecs(listing);
assert.equal(broken.files, 3);
assert.deepEqual(broken.unsupported, [{ path: 'Bweeep.exe', method: 'ARM64 LZMA2:20' }]);
const compatible = inspectNsisCodecs(listing.replace('ARM64 LZMA2:20', 'BCJ LZMA2:20'));
assert.equal(compatible.unsupported.length, 0);
assert.throws(() => inspectNsisCodecs(''), /no readable files/);
console.log('nsis-codecs: ARM64-filter regression rejected; BCJ, BCJ2 and LZMA2 accepted');
