import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {mirrorArtifact} from "./mirror-vps-updates.mjs";
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"bweeep-vps-mirror-"));
const raw=Buffer.from("signed world-free launcher update fixture"),packed=gzipSync(raw);
const hash=b=>createHash("sha256").update(b).digest("hex");
const args={prefix:"blobs/"+hash(packed),size:packed.length,sha256:hash(packed),unpacked:{size:raw.length,sha256:hash(raw)},output:dir,fetcher:async()=>new Response(packed)};
try{
 await mirrorArtifact(args);
 await mirrorArtifact({...args,fetcher:async()=>{throw Error("Unexpected repeat fetch");}});
 await assert.rejects(()=>mirrorArtifact({...args,prefix:"blobs/"+ "1".repeat(64),fetcher:async()=>new Response(Buffer.alloc(packed.length))}),/hash mismatch/);
 await assert.rejects(()=>mirrorArtifact({...args,prefix:"blobs/"+ "2".repeat(64),fetcher:async()=>new Response(packed.subarray(1))}),/size mismatch/);
 assert.equal((await fs.readdir(path.join(dir,"blobs"))).length,1);
 console.log("VPS mirror: verified packed/raw hashes, idempotence, corrupt/truncated source rejection before publication PASS");
}finally{await fs.rm(dir,{recursive:true,force:true});}
