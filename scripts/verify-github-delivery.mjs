import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseAssetUrl, updateBundleRange, readReleaseRange } from "../dist/src/main/github-delivery.js";
import { prepareProtectedInstaller } from "../dist/src/main/protected-installer.js";
import { UPDATE_CHUNK_SIZE } from "../dist/src/main/file-update-manifest.js";
const hash = b => createHash("sha256").update(b).digest("hex");
const bodies = [Buffer.from("unchanged runtime"), Buffer.from("changed app")];
const packed = bodies.map(b => gzipSync(b));
const bundle = Buffer.concat(packed);
const manifest = { version: "0.2.1-beta.2", arch: "arm64", files: packed.map((b,i) => ({ path: i ? "resources/app.js" : "Bweeep.exe", packedSize: b.length })) };
const range = updateBundleRange(manifest, "resources/app.js", 0, UPDATE_CHUNK_SIZE);
assert.deepEqual(range, { start: packed[0].length, end: bundle.length - 1, total: bundle.length });
const response = new Response(bundle.subarray(range.start, range.end+1), { status:206, headers:{ "content-range":`bytes ${range.start}-${range.end}/${range.total}` } });
assert.deepEqual(gunzipSync(await readReleaseRange(response,range.start,range.end,range.total)), bodies[1]);
for (const status of [200,404,416]) await assert.rejects(() => readReleaseRange(new Response(bundle,{status}),range.start,range.end,range.total));
for (const b of [Buffer.alloc(1),Buffer.alloc(3)]) await assert.rejects(() => readReleaseRange(new Response(b,{status:206,headers:{"content-range":"bytes 0-1/2"}}),0,1,2));
await assert.rejects(() => readReleaseRange(new Response(Buffer.alloc(2),{status:206,headers:{"content-range":"bytes 0-1/3"}}),0,1,2));
assert.throws(() => updateBundleRange(manifest,"missing",0,UPDATE_CHUNK_SIZE));
assert.throws(() => updateBundleRange(manifest,"Bweeep.exe",1,UPDATE_CHUNK_SIZE));
assert.throws(() => releaseAssetUrl("../escape", "file.bin"));
assert.match(releaseAssetUrl(manifest.version,"file-update-arm64.bin"),/v0\.2\.1-beta\.2\/file-update-arm64\.bin$/);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const payload = Buffer.alloc(UPDATE_CHUNK_SIZE+7,42);
const signed = { schema:1,version:"0.2.1",arch:"arm64",size:payload.length,sha256:hash(payload),chunkSize:UPDATE_CHUNK_SIZE,chunks:2 };
const descriptor = {...signed,signature:sign(null,Buffer.from(JSON.stringify(signed)),privateKey).toString("base64")};
const stage = await mkdtemp(path.join(os.tmpdir(),"bweeep-github-"));
try {
  for (const mode of ["valid","corrupt","ignored-range","truncated","missing"]) {
    const calls=[];
    const fetcher=async (url,init) => {
      calls.push(url);
      if (url.endsWith("/arm64.json")) return Response.json(descriptor);
      assert.ok(url.startsWith("https://github.com/"),"public GitHub path must not use Storage bodies");
      if (mode === "missing") return new Response(null,{status:404});
      if (mode === "ignored-range") return new Response(payload);
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      let body=Buffer.from(payload.subarray(Number(a),Number(b)+1));
      if(mode==="corrupt") body[0]^=1;
      if(mode==="truncated") body=body.subarray(1);
      return new Response(body,{status:206,headers:{"content-range":`bytes ${a}-${b}/${payload.length}`}});
    };
    const prepare=()=>prepareProtectedInstaller({version:signed.version,arch:signed.arch,publicKey:publicKey.export({type:"spki",format:"pem"}).toString(),stage,signal:new AbortController().signal,fetcher,progress:()=>{}});
    if(mode==="valid") { const result=await prepare();assert.equal(hash(await readFile(result.path)),signed.sha256);assert.equal(calls.length,3); }
    else await assert.rejects(prepare);
    assert.equal((await readdir(stage)).filter(n=>n.endsWith(".part")).length,0);
  }
} finally { await rm(stage,{recursive:true,force:true}); }
console.log("github-delivery: changed-file range, strict response bounds, complete installer hash, legacy fallback and cleanup passed");
