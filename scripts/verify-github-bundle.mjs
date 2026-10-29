import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function verifyGithubBundle(manifest, filename) {
  const bundle = await fsp.open(filename, "r");
  let offset = 0;
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    const total = manifest.files.reduce((sum,file) => sum + file.packedSize,0);
    assert.ok(Number.isSafeInteger(total) && total > 0 && total < 2 * 1024 ** 3);
    assert.equal((await bundle.stat()).size,total,"Bundle length differs from signed file list");
    for (const file of manifest.files) {
      const packed = Buffer.alloc(file.packedSize);
      let received=0;
      while(received<packed.length) {
        const result=await bundle.read(packed,received,packed.length-received,offset+received);
        assert.ok(result.bytesRead>0,"Truncated bundle");received+=result.bytesRead;
      }
      assert.equal(hash(packed),file.packedSha256,`Packed hash mismatch: ${file.path}`);
      const bytes=gunzipSync(packed,{maxOutputLength:Math.max(1,file.size)});
      assert.equal(bytes.length,file.size,`File size mismatch: ${file.path}`);
      assert.equal(hash(bytes),file.sha256,`File hash mismatch: ${file.path}`);
      offset+=packed.length;
    }
  } finally { await bundle.close(); }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await verifyGithubBundle(JSON.parse(await fsp.readFile(process.argv[2],"utf8")),process.argv[3]);
  console.log("GitHub bundle matches every signed packed and unpacked file");
}
