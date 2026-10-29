import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {pathToFileURL} from "node:url";
import {UPDATE_STORAGE_ROOT,UPDATE_CHUNK_SIZE,verifyFileUpdateManifest} from "../dist/src/main/file-update-manifest.js";
import {verifyInstallerDescriptor} from "../dist/src/main/protected-installer.js";
const digest=b=>createHash("sha256").update(b).digest("hex");
async function download(url,fetcher){
 const r=await fetcher(url,{redirect:"error",signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw new Error("Mirror source returned "+r.status);
 return Buffer.from(await r.arrayBuffer());
}
export async function mirrorArtifact({prefix,size,sha256,unpacked,output,fetcher=fetch}){
 if(!/^(?:blobs\/[a-f0-9]{64}|installers\/\d+\.\d+\.\d+(?:-beta\.\d+)?\/(?:x64|arm64)\/[a-f0-9]{64})$/.test(prefix))throw new Error("Invalid mirror artifact path");
 const count=Math.ceil(size/UPDATE_CHUNK_SIZE),parts=[];
 for(let i=0;i<count;i++){
  const relative=prefix+"/part-"+String(i).padStart(4,"0")+".bin";
  const target=path.join(output,relative);
  let bytes;try{bytes=await fs.readFile(target);}catch(e){if(e.code!=="ENOENT")throw e;}
  bytes??=await download(UPDATE_STORAGE_ROOT+"/"+relative,fetcher);
  if(bytes.length!==Math.min(UPDATE_CHUNK_SIZE,size-i*UPDATE_CHUNK_SIZE))throw new Error("Mirror chunk size mismatch");
  parts.push({relative,bytes});
 }
 const packed=Buffer.concat(parts.map(p=>p.bytes));
 if(digest(packed)!==sha256)throw new Error("Mirror payload hash mismatch");
 if(unpacked){const raw=gunzipSync(packed,{maxOutputLength:unpacked.size+1});if(raw.length!==unpacked.size||digest(raw)!==unpacked.sha256)throw new Error("Mirror unpacked hash mismatch");}
 for(const {relative,bytes} of parts){
  const target=path.join(output,relative);await fs.mkdir(path.dirname(target),{recursive:true});
  const tmp=target+".tmp-"+process.pid;
  await fs.writeFile(tmp,bytes,{flag:"wx",mode:0o644});
  try{await fs.link(tmp,target);}
  catch(e){if(e.code!=="EEXIST"||digest(await fs.readFile(target))!==digest(bytes))throw e;}
  finally{await fs.rm(tmp,{force:true});}
 }
}
async function main(){
 const [output,publicKeyFile]=process.argv.slice(2);
 if(!output||!publicKeyFile||!path.isAbsolute(output))throw new Error("usage: mirror-vps-updates ABSOLUTE_PUBLIC_DIRECTORY PUBLIC_KEY_FILE");
 const publicKey=await fs.readFile(publicKeyFile,"utf8"),seen=new Set();
 for(const channel of ["stable","beta"])for(const arch of ["x64","arm64"]){
  const manifest=JSON.parse((await download(UPDATE_STORAGE_ROOT+"/channels/"+channel+"/"+arch+".json",fetch)).toString("utf8"));
  verifyFileUpdateManifest(manifest,publicKey,"0.0.0",channel,arch);
  let next=0;
  const workers=Array.from({length:6},async()=>{
   while(next<manifest.files.length){
    const f=manifest.files[next++];if(seen.has(f.packedSha256))continue;seen.add(f.packedSha256);
    await mirrorArtifact({prefix:"blobs/"+f.packedSha256,size:f.packedSize,sha256:f.packedSha256,unpacked:{size:f.size,sha256:f.sha256},output});
   }
  });
  await Promise.all(workers);
  const descriptor=JSON.parse((await download(UPDATE_STORAGE_ROOT+"/installers/"+manifest.version+"/"+arch+".json",fetch)).toString("utf8"));
  const d=verifyInstallerDescriptor(descriptor,publicKey,manifest.version,arch);
  await mirrorArtifact({prefix:"installers/"+d.version+"/"+arch+"/"+d.sha256,size:d.size,sha256:d.sha256,output});
  console.log("VPS_MIRROR_VERIFIED",channel,arch,manifest.version,manifest.files.length);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exit(1);});
