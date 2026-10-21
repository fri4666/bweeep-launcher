// Local fixtures only: no game, user profile, external network or remote configuration changes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import yazl from 'yazl';
import * as yauzl from 'yauzl';
const compiledRoot=new URL(process.env.BWEEP_BUNDLE_TEST_DIST??'../dist/',import.meta.url);
const { applyInstallBundle, isInstallBundleFile, shouldUseInstallBundle }=await import(new URL('src/main/install-bundle.js',compiledRoot));
const { downloadVerified }=await import(new URL('src/main/download.js',compiledRoot));
const { syncModpack }=await import(new URL('src/main/sync.js',compiledRoot));
const { assertManifest }=await import(new URL('src/main/manifest-validation.js',compiledRoot));
import { buildInstallBundle } from './build-install-bundle.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'bweeep-bundle-check-'));
const hash=(algorithm,bytes)=>crypto.createHash(algorithm).update(bytes).digest('hex');
const filesFor=entries=>Object.entries(entries).map(([name,bytes])=>({path:name,size:bytes.length,sha512:hash('sha512',bytes),url:'https://files.invalid/'+name}));
const data={'mods/a.jar':Buffer.from('first pinned mod'),'mods/b.jar':Buffer.from('second pinned mod')};
const files=filesFor(data),bodies=new Map(),requests=[];
files[0]={path:files[0].path,size:files[0].size,sha256:hash('sha256',data['mods/a.jar']),url:files[0].url};
let interrupt=false;
const server=http.createServer((request,response)=>{
  const name=new URL(request.url,'http://local').pathname,body=bodies.get(name);
  requests.push({name,range:request.headers.range??null});
  if(!body){response.writeHead(404).end();return;}
  const start=Number(/^bytes=(\d+)-$/.exec(request.headers.range??'')?.[1]??0);
  const headers={'content-length':body.length-start,'accept-ranges':'bytes'};
  if(start)headers['content-range']=`bytes ${start}-${body.length-1}/${body.length}`;
  response.writeHead(start?206:200,headers);
  if(interrupt){interrupt=false;response.write(body.subarray(start,start+16384));setTimeout(()=>response.destroy(),50);return;}
  response.end(body.subarray(start));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const fetcher=(url,init)=>fetch(base+new URL(url).pathname,init);
const options={fetch:fetcher,tries:1,retryDelayMs:0,freeBytes:async()=>2**40};
const quiet=()=>{};
let checks=0;
async function check(name,work){await work();checks++;console.log('PASS '+name);}
async function instance(name){const target=path.join(root,name);await fs.mkdir(target,{recursive:true});return target;}
function archive(entries){return Buffer.from(zipSync(entries,{level:0,mtime:'2000-01-01T00:00:00Z'}));}
function source(bytes,name='bundle.zip'){bodies.set('/'+name,bytes);return {url:'https://bundles.invalid/'+name,size:bytes.length,sha512:hash('sha512',bytes)};}
async function apply(name,bytes,expected=files,needed=expected,extra={}) {
  const target=await instance(name),bundle=source(bytes,name+'.zip');
  const committed=await applyInstallBundle(bundle,target,expected,needed,quiet,{...options,...extra});
  return {target,bundle,committed};
}
async function cleanStaging(target) {
  const names=await fs.readdir(path.join(target,'.bweeep','install-bundles')).catch(()=>[]);
  assert.equal(names.some(name=>name.startsWith('extract-')),false);
}
async function specialArchive({duplicate=false,firstMode}={}) {
  const zip=new yazl.ZipFile(),chunks=[];
  zip.outputStream.on('data',chunk=>chunks.push(chunk));
  const done=new Promise((resolve,reject)=>{zip.outputStream.on('end',resolve);zip.on('error',reject);});
  let index=0;
  for(const [name,bytes] of Object.entries(data))zip.addBuffer(bytes,name,{compress:false,...(index++===0 && firstMode!==undefined?{mode:firstMode}:{})});
  if(duplicate)zip.addBuffer(data['mods/a.jar'],'mods/a.jar',{compress:false});zip.end();await done;
  return Buffer.concat(chunks);
}
async function zipEntries(file) {
  const zip=await new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));
  return new Promise((resolve,reject)=>{const entries=[];zip.on('error',reject);zip.on('end',()=>resolve(entries));zip.on('entry',entry=>{entries.push({name:entry.fileName,compression:entry.compressionMethod});zip.readEntry();});zip.readEntry();});
}
const manifestFor=(id,managed,bundle)=>({schemaVersion:1,id,name:'Bundle test',version:'1',minecraftVersion:'1.20.1',java:{majorVersion:17,component:'java-runtime-gamma'},loader:{kind:'forge',version:'47.4.0'},server:{host:'example.invalid',port:25565},files:managed,initialInstallBundle:bundle});
let bulk;
function partialBulk() {
  if(bulk)return bulk;
  const bundled=Object.fromEntries(Array.from({length:128},(_,index)=>[`mods/partial-${index}.jar`,Buffer.alloc(256*1024,index)]));
  const independent=Object.fromEntries(Array.from({length:8},(_,index)=>[`mods/large-${index}.jar`,Buffer.alloc(1024*1024,index+128)]));
  const all={...bundled,...independent},managed=filesFor(all);
  for(const [name,bytes] of Object.entries(all))bodies.set('/'+name,bytes);
  const bundle={...source(archive(bundled),'partial-bulk.zip'),paths:Object.keys(bundled)};
  bulk={bundled,independent,all,managed,bundle};
  return bulk;
}

try {
  await check('only immutable managed archives are eligible; ordinary updates stay per-file',async()=>{
    for(const name of ['options.txt','saves/world.zip','logs/latest.zip','.bweeep/auth.jar','config/secret.zip','mods/../bad.jar','mods/CON.jar','mods/a.jar:secret','mods/CrashAssistant-1.jar'])assert.equal(isInstallBundleFile({path:name}),false,name);
    for(const name of ['mods/ok.jar','resourcepacks/p.zip','shaderpacks/p.zip'])assert.equal(isInstallBundleFile({path:name}),true,name);
    const bulk=Array.from({length:160},(_,index)=>({path:`mods/${index}.jar`,size:1024*1024}));
    assert.equal(shouldUseInstallBundle({size:161*1024*1024},bulk,bulk),true);
    assert.equal(shouldUseInstallBundle({size:161*1024*1024},bulk,bulk.slice(0,128)),true);
    assert.equal(shouldUseInstallBundle({size:161*1024*1024},bulk,bulk.slice(0,127)),false);
    assert.equal(shouldUseInstallBundle({size:161*1024*1024},bulk,bulk.slice(0,1)),false);
    assert.equal(shouldUseInstallBundle({size:161*1024*1024},bulk,bulk.slice(0,80)),false);
    assert.equal(shouldUseInstallBundle({size:1000*1024*1024},bulk,bulk),false);
    assert.equal(shouldUseInstallBundle({size:33*1024*1024},bulk.slice(0,32),bulk.slice(0,32)),false);
  });
  await check('verified ZIP installs exact needed files and preserves user settings/worlds/personal mods',async()=>{
    const target=await instance('valid');
    for(const name of ['options.txt','config/client.toml','saves/world/level.dat','logs/latest.log','mods/personal.jar']){await fs.mkdir(path.dirname(path.join(target,name)),{recursive:true});await fs.writeFile(path.join(target,name),'user data');}
    const committed=[];
    const installed=await applyInstallBundle(source(archive(data)),target,files,files,quiet,{...options,onCommitted:async file=>committed.push(file.path)});
    assert.deepEqual(installed.map(file=>file.path),files.map(file=>file.path), 'return order remains the requested file order');
    assert.deepEqual(committed.sort(),files.map(file=>file.path).sort());
    for(const [name,bytes] of Object.entries(data))assert.deepEqual(await fs.readFile(path.join(target,name)),bytes);
    for(const name of ['options.txt','config/client.toml','saves/world/level.dat','logs/latest.log','mods/personal.jar'])assert.equal(await fs.readFile(path.join(target,name),'utf8'),'user data');
    await cleanStaging(target);
  });
  await check('cached verified ZIP restores only requested files without another network request',async()=>{
    const target=path.join(root,'valid'),bundle=source(archive(data));
    await fs.rm(path.join(target,'mods/a.jar'));
    await fs.writeFile(path.join(target,'mods/b.jar'),'retained by caller');
    await applyInstallBundle(bundle,target,files,[files[0]],quiet,{...options,fetch:()=>{throw new Error('unexpected network');}});
    assert.deepEqual(await fs.readFile(path.join(target,'mods/a.jar')),data['mods/a.jar']);
    assert.equal(await fs.readFile(path.join(target,'mods/b.jar'),'utf8'),'retained by caller');
  });
  await check('outer SHA512 mismatch commits nothing and discards invalid part',async()=>{
    const target=await instance('outer'),bundle={...source(archive(data),'outer.zip'),sha512:'0'.repeat(128)};
    await assert.rejects(applyInstallBundle(bundle,target,files,files,quiet,options),/해시/);
    assert.equal(await fs.stat(path.join(target,'mods/a.jar')).then(()=>true,()=>false),false);
    assert.equal(await fs.stat(path.join(target,'.bweeep/install-bundles',bundle.sha512+'.zip.part')).then(()=>true,()=>false),false);
  });
  await check('wrong-version inner hash verifies the full selected set before replacing any file',async()=>{
    const target=await instance('inner');await fs.mkdir(path.join(target,'mods'));await fs.writeFile(path.join(target,'mods/a.jar'),'old valid local');
    const wrong={...data,'mods/b.jar':Buffer.from('X'.repeat(data['mods/b.jar'].length))};
    await assert.rejects(applyInstallBundle(source(archive(wrong),'inner.zip'),target,files,files,quiet,options),/해시/);
    assert.equal(await fs.readFile(path.join(target,'mods/a.jar'),'utf8'),'old valid local');
    await cleanStaging(target);
  });
  await check('concurrent corruption drains all four active streams before cleanup and commits nothing',async()=>{
    const target=await instance('concurrent-failure');
    const expected=Object.fromEntries(Array.from({length:4},(_,index)=>[`mods/${index}.jar`,crypto.randomBytes(65536)]));
    const wrong={...expected,'mods/0.jar':Buffer.alloc(65536,0)};
    let started=0,active=0,maximum=0,release;
    const gate=new Promise(resolve=>{release=resolve;}),original=nativeFs.createWriteStream;
    nativeFs.createWriteStream=function(file,...args){
      const stream=original.call(this,file,...args);
      if(String(file).includes(path.sep+'extract-')) {
        started++;active++;maximum=Math.max(maximum,active);stream.once('close',()=>active--);
        if(started===4)release();
        const final=stream._final;
        stream._final=function(callback){gate.then(()=>typeof final==='function'?final.call(this,callback):callback(),callback);};
      }
      return stream;
    };
    try {await assert.rejects(applyInstallBundle(source(archive(wrong),'concurrent.zip'),target,filesFor(expected),filesFor(expected),quiet,options),/해시/);}
    finally {release();nativeFs.createWriteStream=original;}
    assert.equal(started,4);assert.equal(maximum,4);assert.equal(active,0);
    for(const name of Object.keys(expected))assert.equal(await fs.stat(path.join(target,name)).then(()=>true,()=>false),false);
    await cleanStaging(target);
  });
  await check('size mismatch, incomplete inventory, forbidden and unsafe entries are rejected',async()=>{
    const fixtures=[{...data,'mods/b.jar':Buffer.from('short')},{'mods/a.jar':data['mods/a.jar']},{...data,'options.txt':Buffer.from('overwrite')},{...data,'../escape.txt':Buffer.from('escape')}];
    for(let index=0;index<fixtures.length;index++){
      const target=await instance('inventory-'+index);
      await assert.rejects(applyInstallBundle(source(archive(fixtures[index]),'inventory-'+index+'.zip'),target,files,files,quiet,options));
      assert.equal(await fs.stat(path.join(target,'mods/a.jar')).then(()=>true,()=>false),false);
      await cleanStaging(target);
    }
  });
  await check('duplicate ZIP paths, symlink/directory entries and Windows case aliases are denied',async()=>{
    await assert.rejects(apply('duplicates',await specialArchive({duplicate:true})),/중복|일치/);
    await assert.rejects(apply('archive-link',await specialArchive({firstMode:0o120777})),/일치/);
    await assert.rejects(apply('archive-dir',await specialArchive({firstMode:0o040755})),/일치/);
    const target=await instance('aliases');
    await assert.rejects(applyInstallBundle(source(archive(data)),target,[files[0],{...files[0],path:'mods/A.jar'}],files,quiet,options),/중복/);
  });
  await check('symlink destination cannot escape the instance',async()=>{
    const target=await instance('symlink'),outside=await instance('outside');
    await fs.writeFile(path.join(outside,'a.jar'),'outside');await fs.symlink(outside,path.join(target,'mods'),'dir');
    await assert.rejects(applyInstallBundle(source(archive(data)),target,files,files,quiet,options),/링크/);
    assert.equal(await fs.readFile(path.join(outside,'a.jar'),'utf8'),'outside');await cleanStaging(target);
  });
  await check('network interruption preserves partial ZIP and next attempt resumes its Range',async()=>{
    const big={'mods/a.jar':crypto.randomBytes(100000),'mods/b.jar':crypto.randomBytes(100000)},bigFiles=filesFor(big);
    const target=await instance('resume'),bundle=source(archive(big),'resume.zip');interrupt=true;
    await assert.rejects(applyInstallBundle(bundle,target,bigFiles,bigFiles,quiet,options));
    const part=path.join(target,'.bweeep/install-bundles',bundle.sha512+'.zip.part'),offset=(await fs.stat(part)).size;
    assert(offset>0 && offset<bundle.size);
    await applyInstallBundle(bundle,target,bigFiles,bigFiles,quiet,options);
    assert(requests.some(request=>request.name==='/resume.zip' && request.range===`bytes=${offset}-`));
    for(const [name,bytes] of Object.entries(big))assert.deepEqual(await fs.readFile(path.join(target,name)),bytes);
  });
  await check('a late commit error keeps verified earlier files and per-file fallback finishes safely',async()=>{
    const target=await instance('fallback');let committed=0;
    const repairData=Object.fromEntries(Array.from({length:8},(_,index)=>[`mods/${index}.jar`,Buffer.from('pinned mod '+index)])),repairFiles=filesFor(repairData);
    await assert.rejects(applyInstallBundle(source(archive(repairData),'fallback.zip'),target,repairFiles,repairFiles,quiet,{...options,onCommitted:async()=>{if(++committed===1)throw new Error('simulated interruption');}}),/simulated/);
    assert(committed>=1 && committed<=4, 'the failure stops new commits and drains the at most four already active commits');
    const remaining=[];
    for(const file of repairFiles){const bytes=await fs.readFile(path.join(target,file.path)).catch(()=>null);if(bytes)assert.deepEqual(bytes,repairData[file.path]);else remaining.push(file);}
    assert(remaining.length>=4);
    for(const file of remaining){bodies.set('/'+file.path,repairData[file.path]);await downloadVerified({...file,target:path.join(target,file.path)},{fetch:fetcher,tries:1});}
    for(const file of repairFiles)assert.deepEqual(await fs.readFile(path.join(target,file.path)),repairData[file.path]);
    await cleanStaging(target);
  });
  await check('insufficient staging space fails before download',async()=>{
    const target=await instance('space');let calls=0;
    await assert.rejects(applyInstallBundle(source(archive(data)),target,files,files,quiet,{...options,freeBytes:async()=>0,fetch:()=>{calls++;throw new Error('not reached');}}),/공간/);
    assert.equal(calls,0);
  });
  await check('partial bundle paths validate canonical subset membership and exact ZIP inventory',async()=>{
    const subset={'mods/a.jar':data['mods/a.jar']};
    const bundle={...source(archive(subset),'subset.zip'),paths:['mods/a.jar']};
    const target=await instance('partial-subset');
    const installed=await applyInstallBundle(bundle,target,files,files,quiet,options);
    assert.deepEqual(installed.map(file=>file.path),['mods/a.jar']);
    assert.deepEqual(await fs.readFile(path.join(target,'mods/a.jar')),data['mods/a.jar']);
    assert.equal(await fs.stat(path.join(target,'mods/b.jar')).then(()=>true,()=>false),false);
    const manifest=manifestFor('paths',files,bundle);
    assert.doesNotThrow(()=>assertManifest(manifest));
    for(const paths of [[],['mods/a.jar','mods/A.jar'],['mods/missing.jar'],['options.txt'],['mods/./a.jar'],['mods/../a.jar'],new Array(1),Array(20001).fill('mods/a.jar')]){
      const invalid={...bundle,paths};
      assert.throws(()=>assertManifest({...manifest,initialInstallBundle:invalid}),/묶음/);
      assert.equal(shouldUseInstallBundle(invalid,files,files),false);
      await assert.rejects(applyInstallBundle(invalid,await instance('invalid-paths-'+Math.random().toString(16).slice(2)),files,files,quiet,options),/묶음/);
    }
    await assert.rejects(applyInstallBundle({...source(archive(data),'subset-extra.zip'),paths:['mods/a.jar']},await instance('subset-extra'),files,files,quiet,options),/일치/);
    await assert.rejects(applyInstallBundle({...source(archive({}),'subset-missing.zip'),paths:['mods/a.jar']},await instance('subset-missing'),files,files,quiet,options),/빠져/);
  });
  await check('partial initial ZIP and remaining CDN files overlap; warm and small repairs avoid ZIP',async()=>{
    const fixture=partialBulk(),manifest=manifestFor('partial-sync',fixture.managed,fixture.bundle);
    assert.equal(shouldUseInstallBundle(fixture.bundle,fixture.managed,fixture.managed),true);
    let directStarted=false,releaseDirect,timer;
    const directGate=new Promise(resolve=>{releaseDirect=resolve;});
    const fetch=async(url,init)=>{
      if(new URL(url).pathname==='/partial-bulk.zip')await Promise.race([directGate,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDN files did not start alongside ZIP')),3000);})]);
      else {directStarted=true;releaseDirect();}
      return fetcher(url,init);
    };
    const start=requests.length;
    let result;
    try {result=await syncModpack({instanceDir:root,manifest},quiet,{...options,fetch});}finally{releaseDirect();clearTimeout(timer);}
    assert(directStarted);
    assert.equal(result.downloaded,fixture.managed.length);
    assert.equal(result.skipped,0);
    const first=requests.slice(start);
    assert.equal(first.filter(request=>request.name==='/partial-bulk.zip').length,1);
    assert.equal(first.filter(request=>request.name.startsWith('/mods/large-')).length,8);
    assert.equal(first.some(request=>request.name.startsWith('/mods/partial-')),false);
    for(const [name,bytes] of Object.entries(fixture.all))assert.deepEqual(await fs.readFile(path.join(result.instanceDir,name)),bytes);
    const beforeWarm=requests.length;
    const warm=await syncModpack({instanceDir:root,manifest},quiet,{...options,fetch:()=>{throw new Error('warm launch must not fetch');}});
    assert.equal(warm.downloaded,0);assert.equal(warm.skipped,fixture.managed.length);assert.equal(requests.length,beforeWarm);
    await fs.unlink(path.join(result.instanceDir,'mods/partial-0.jar'));
    const repair=await syncModpack({instanceDir:root,manifest},quiet,options);
    assert.equal(repair.downloaded,1);
    assert.deepEqual(requests.slice(beforeWarm).map(request=>request.name),['/mods/partial-0.jar']);
  });
  await check('partial ZIP failure falls back only its missing partition without repeating successful CDN files',async()=>{
    const fixture=partialBulk();
    const manifest=manifestFor('partial-fallback',fixture.managed,{...fixture.bundle,sha512:'0'.repeat(128)});
    const start=requests.length;
    const result=await syncModpack({instanceDir:root,manifest},quiet,options);
    assert.equal(result.downloaded,fixture.managed.length);
    const seen=requests.slice(start);
    for(const name of Object.keys(fixture.independent))assert.equal(seen.filter(request=>request.name==='/'+name).length,1,name);
    for(const name of Object.keys(fixture.bundled))assert.equal(seen.filter(request=>request.name==='/'+name).length,1,name);
    await cleanStaging(result.instanceDir);
  });
  await check('failed parallel CDN work drains the ZIP branch before rejection and resumes verified entries',async()=>{
    const fixture=partialBulk(),manifest=manifestFor('partial-drain',fixture.managed,fixture.bundle);
    const failingFetch=(url,init)=>new URL(url).pathname==='/mods/large-0.jar'?Promise.reject(new Error('separate CDN failed')):fetcher(url,init);
    await assert.rejects(syncModpack({instanceDir:root,manifest},quiet,{...options,fetch:failingFetch}),/separate CDN failed/);
    const target=path.join(root,manifest.id);
    for(const [name,bytes] of Object.entries(fixture.bundled))assert.deepEqual(await fs.readFile(path.join(target,name)),bytes);
    await cleanStaging(target);
    const start=requests.length;
    const resumed=await syncModpack({instanceDir:root,manifest},quiet,options);
    assert(resumed.downloaded>=1 && resumed.downloaded<=8);
    assert.equal(requests.slice(start).some(request=>request.name.endsWith('.zip')||request.name.startsWith('/mods/partial-')),false);
    assert.equal(resumed.downloaded+resumed.skipped,fixture.managed.length);
  });
  await check('builder resolves pinned mrpack index, stores verified archives and excludes userdata/CrashAssistant',async()=>{
    const target=await instance('builder'),mods={'mods/a.jar':data['mods/a.jar'],'mods/b.jar':data['mods/b.jar'],'mods/CrashAssistant-1.jar':Buffer.from('excluded')};
    for(const [name,bytes] of Object.entries(mods)){await fs.mkdir(path.dirname(path.join(target,name)),{recursive:true});await fs.writeFile(path.join(target,name),bytes);}
    await fs.writeFile(path.join(target,'options.txt'),'personal data');
    const mrpackFiles=filesFor({'mods/b.jar':data['mods/b.jar'],'mods/CrashAssistant-1.jar':mods['mods/CrashAssistant-1.jar']});
    const index={formatVersion:1,dependencies:{minecraft:'1.20.1',forge:'47.4.0'},files:mrpackFiles.map(file=>({path:file.path,fileSize:file.size,hashes:{sha512:file.sha512},downloads:[file.url]}))};
    const mrpack=archive({'modrinth.index.json':Buffer.from(JSON.stringify(index))}),mrpackPath=path.join(root,'source.mrpack');await fs.writeFile(mrpackPath,mrpack);
    const manifest={schemaVersion:1,id:'test',name:'test',version:'1',minecraftVersion:'1.20.1',java:{majorVersion:17,component:'java-runtime-gamma'},loader:{kind:'forge',version:'47.4.0'},server:{host:'example.invalid',port:25565},files:[files[0]],mrpack:{url:'https://files.invalid/source.mrpack',size:mrpack.length,sha512:hash('sha512',mrpack)}};
    const manifestPath=path.join(root,'manifest.json');await fs.writeFile(manifestPath,JSON.stringify(manifest));
    const output=path.join(root,'built.zip'),metadata=await buildInstallBundle({manifestPath,instanceDir:target,output,url:'https://bundles.invalid/built.zip',mrpackPath});
    assert.equal(metadata.fileCount,2);assert.equal(metadata.maxActiveSourceStreams,1);assert.equal(metadata.compression,'STORE');
    assert(metadata.files.every(file=>!('url' in file)), 'origin download URLs must not be persisted in bundle inventory');
    assert.deepEqual(await zipEntries(output),[{name:'mods/a.jar',compression:0},{name:'mods/b.jar',compression:0}]);
    await assert.rejects(buildInstallBundle({manifestPath,instanceDir:target,output,url:'https://bundles.invalid/built.zip',mrpackPath}),/exists/);
    const wrong={...manifest,loader:{kind:'forge',version:'47.3.0'}};await fs.writeFile(manifestPath,JSON.stringify(wrong));
    await assert.rejects(buildInstallBundle({manifestPath,instanceDir:target,output:path.join(root,'wrong.zip'),url:'https://bundles.invalid/wrong.zip',mrpackPath}),/version/);
  });
  console.log(`Install bundle verification passed: ${checks} checks.`);
} finally {
  await new Promise(resolve=>server.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
