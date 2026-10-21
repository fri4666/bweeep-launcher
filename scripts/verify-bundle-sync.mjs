// Integration fixtures only. Simulated request latency is not an Internet/game benchmark.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { zipSync } from 'fflate';
import { syncModpack } from '../dist/src/main/sync.js';
import { assertManifest } from '../dist/src/main/manifest-validation.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bweeep-bundle-sync-'));
const sha=(kind,bytes)=>crypto.createHash(kind).update(bytes).digest('hex');
const payloads=Object.fromEntries(Array.from({length:192},(_,i)=>['mods/fixture-'+i+'.jar',Buffer.alloc(256*1024,i)]));
const files=Object.entries(payloads).map(([name,bytes])=>({path:name,size:bytes.length,sha256:sha('sha256',bytes),url:'https://files.invalid/'+name}));
const archive=Buffer.from(zipSync(payloads,{level:0,mtime:'2000-01-01T00:00:00Z'}));
const source={url:'https://bundle.invalid/initial.zip',size:archive.length,sha512:sha('sha512',archive)};
const manifest={schemaVersion:1,id:'fixture',name:'Local fixture',version:'1',minecraftVersion:'1.20.1',java:{majorVersion:17,component:'fixture'},loader:{kind:'forge',version:'47.4.0'},server:{host:'localhost',port:25565},files};
const options={tries:1,retryDelayMs:0,freeBytes:async()=>2**40};
const rows=[];
async function run(name,base,bundle,latency=0,corrupt=false){
 const requests=[];const progress=[];
 const fetcher=async(url)=>{requests.push(url);if(latency)await new Promise(r=>setTimeout(r,latency));const bytes=url===source.url?(corrupt?Buffer.alloc(archive.length):archive):payloads[new URL(url).pathname.slice(1)];return new Response(bytes,{status:bytes?200:404});};
 const input={...manifest,...(bundle?{initialInstallBundle:bundle}:{})};assertManifest(input);
 const start=performance.now();const result=await syncModpack({instanceDir:base,manifest:input},e=>progress.push(e),{...options,fetch:fetcher});
 const row={name,seconds:+((performance.now()-start)/1000).toFixed(6),requests:requests.length,bundleRequests:requests.filter(url=>url===source.url).length,downloaded:result.downloaded,skipped:result.skipped,simulatedRequestLatencyMs:latency};rows.push(row);
 for(const event of progress){if(event.unit==='bytes')assert.ok(event.total>0&&event.completed>=0&&event.completed<=event.total);}
 return {row,result,requests,progress};
}
try{
 await fs.mkdir(root,{recursive:true});
 for(const invalid of [{...source,url:'http://bundle.invalid/file'}, {...source,size:0}, {...source,sha512:'bad'}])assert.throws(()=>assertManifest({...manifest,initialInstallBundle:invalid}));
 const single=await run('per-file initial',path.join(root,'per-file'),null,150);assert.equal(single.row.requests,192);assert.equal(single.row.downloaded,192);
 const bundledRoot=path.join(root,'bundled');
 const bundled=await run('ZIP initial',bundledRoot,source,150);assert.equal(bundled.row.requests,1);assert.equal(bundled.row.bundleRequests,1);assert.equal(bundled.row.downloaded,192);
 for(const file of files)assert.equal(sha('sha256',await fs.readFile(path.join(bundled.result.instanceDir,file.path))),file.sha256);
 const warm=await run('ZIP warm',bundledRoot,source);assert.equal(warm.row.requests,0);assert.equal(warm.row.downloaded,0);assert.equal(warm.row.skipped,192);
 await fs.unlink(path.join(bundled.result.instanceDir,files[0].path));
 const update=await run('one missing',bundledRoot,source);assert.equal(update.row.requests,1);assert.equal(update.row.bundleRequests,0);assert.equal(update.row.downloaded,1);
 const fallback=await run('bad ZIP fallback',path.join(root,'fallback'),source,0,true);assert.equal(fallback.row.downloaded,192);assert.equal(fallback.requests.filter(url=>url.startsWith('https://files.invalid/')).length,192);assert.ok(fallback.progress.some(e=>e.message.includes('개별 파일')));
 const empty=await syncModpack({instanceDir:path.join(root,'empty'),manifest:{...manifest,files:[],initialInstallBundle:source}},()=>{},{...options,fetch:async()=>{throw new Error('Unexpected fetch for empty pack');}});assert.equal(empty.downloaded,0);
 const report={environment:'WSL local fixtures; 192 synthetic 256KiB JAR payloads, STORE ZIP; request latency is injected, not real network',samplesPerCase:1,rows};
 console.log(JSON.stringify(report));console.log('bundle-sync-first-warm-missing-fallback-empty-progress=passed');
}finally{await fs.rm(root,{recursive:true,force:true});}
