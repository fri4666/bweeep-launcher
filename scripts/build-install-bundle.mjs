// Build a publishable initial-install ZIP from a pinned manifest and verified local pack files.
// Never crawls the instance or packages its settings, saves, logs, skins or authentication data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import * as yauzl from 'yauzl';
import yazl from 'yazl';
import { assertManifest } from '../dist/src/main/manifest-validation.js';
import { isInstallBundleFile } from '../dist/src/main/install-bundle.js';
import { hashFile } from '../dist/src/main/hash.js';

export async function buildInstallBundle({manifestPath,instanceDir,output,url,mrpackPath,maxBytes}) {
  const address=new URL(url);
  if(address.protocol!=='https:' || address.username || address.password)throw new Error('A public HTTPS bundle URL is required; this script does not publish it.');
  const manifest=JSON.parse(await fsp.readFile(manifestPath,'utf8'));
  assertManifest(manifest);
  const root=path.resolve(instanceDir),target=path.resolve(output);
  const relativeOutput=path.relative(root,target);
  if(relativeOutput==='' || (!relativeOutput.startsWith('..'+path.sep) && relativeOutput!=='..' && !path.isAbsolute(relativeOutput)))throw new Error('Bundle output must be outside the source instance.');
  for(const artifact of [target,target+'.part',target+'.json']) {
    try {await fsp.lstat(artifact);throw new Error('Output already exists: '+artifact);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const files=[...manifest.files];
  if(manifest.mrpack) {
    const archive=mrpackPath ?? path.join(root,'.bweeep','mrpack',manifest.mrpack.sha512+'.mrpack');
    const stat=await fsp.stat(archive);
    if(stat.size!==manifest.mrpack.size || await hashFile(archive,'sha512')!==manifest.mrpack.sha512.toLowerCase())throw new Error('Cached mrpack does not match the manifest size/hash.');
    const index=await readMrpackIndex(archive);
    const loaderKey=manifest.loader.kind==='fabric'?'fabric-loader':manifest.loader.kind;
    if(index.formatVersion!==1 || !Array.isArray(index.files) || index.dependencies?.minecraft!==manifest.minecraftVersion || index.dependencies?.[loaderKey]!==manifest.loader.version)throw new Error('Mrpack Minecraft/loader version does not match the manifest.');
    for(const item of index.files) {
      if(typeof item.path!=='string' || !Number.isSafeInteger(item.fileSize) || item.fileSize<0 || !/^[a-f0-9]{128}$/i.test(item.hashes?.sha512??'') || !Array.isArray(item.downloads) || item.downloads.length!==1 || !item.downloads[0].startsWith('https://'))throw new Error('Invalid pinned mrpack file.');
      files.push({path:item.path,size:item.fileSize,sha512:item.hashes.sha512,url:item.downloads[0]});
    }
  }
  const eligible=files.filter(isInstallBundleFile);
  if(maxBytes!==undefined && (!Number.isSafeInteger(maxBytes) || maxBytes<=22 || maxBytes>=0xffffffff))throw new Error('maxBytes must be an integer ZIP limit below 4GiB.');
  let selected=eligible.sort((a,b)=>a.path.localeCompare(b.path));
  if(maxBytes!==undefined) {
    // STORE ZIP overhead: local header30 + descriptor16 + central record46 + twice the UTF8 name; end record22.
    let estimated=22;
    selected=[];
    for(const file of [...eligible].sort((a,b)=>a.size-b.size || a.path.localeCompare(b.path))) {
      const bytes=file.size+92+2*Buffer.byteLength(file.path);
      if(estimated+bytes>maxBytes)continue;
      selected.push(file);estimated+=bytes;
    }
    selected.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    if(selected.length>20_000)throw new Error('A partial bundle cannot contain more than 20,000 paths.');
  }
  if(!selected.length)throw new Error('No immutable managed files are eligible for a bundle.');
  const aliases=new Set();
  for(const file of selected) {
    if(aliases.has(file.path.toLowerCase()))throw new Error('Duplicate/case-alias bundle path: '+file.path);
    aliases.add(file.path.toLowerCase());
    await assertNoLinks(root,file.path);
  }
  await fsp.mkdir(path.dirname(target),{recursive:true});
  const temp=target+'.part';
  const zip=new yazl.ZipFile(),streams=[];
  let outputHandle;
  let active=0,maxActiveSourceStreams=0;
  zip.on('error',error=>zip.outputStream.destroy(error));
  try {
    outputHandle=await fsp.open(temp,'wx');
    const writing=pipeline(zip.outputStream,outputHandle.createWriteStream());
    for(const file of selected) {
      const stream=Readable.from((async function*() {
        active++;maxActiveSourceStreams=Math.max(active,maxActiveSourceStreams);
        const algorithm=file.sha256?'sha256':'sha512',hash=crypto.createHash(algorithm);
        let size=0;
        try {
          for await(const chunk of fs.createReadStream(path.join(root,file.path))) {
            size+=chunk.length;
            if(size>file.size)throw new Error('Local file exceeds its pinned size: '+file.path);
            hash.update(chunk);
            yield chunk;
          }
          if(size!==file.size || hash.digest('hex')!==(file.sha256??file.sha512).toLowerCase())throw new Error('Local file does not match its pinned hash: '+file.path);
        } finally { active--; }
      })());
      stream.on('error',error=>zip.outputStream.destroy(error));
      streams.push(stream);
      zip.addReadStream(stream,file.path,{compress:false,size:file.size,mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100644});
    }
    zip.end();
    await writing;
    const size=(await fsp.stat(temp)).size,sha512=await hashFile(temp,'sha512');
    if(maxBytes!==undefined && size>maxBytes)throw new Error('The final ZIP exceeds maxBytes.');
    await fsp.rename(temp,target);
    const inventory=selected.map(({path,size,sha256,sha512})=>({path,size,...(sha256?{sha256}:{}),...(sha512?{sha512}:{})}));
    const metadata={packId:manifest.id,packVersion:manifest.version,initialInstallBundle:{url:address.href,size,sha512,...(maxBytes!==undefined?{paths:selected.map(file=>file.path)}:{})},files:inventory,fileCount:selected.length,uncompressedBytes:selected.reduce((sum,file)=>sum+file.size,0),compression:'STORE',maxActiveSourceStreams,...(maxBytes!==undefined?{maxBytes}:{}),excludedLargeFileCount:eligible.length-selected.length};
    await fsp.writeFile(target+'.json',JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
    return metadata;
  } catch(error) {
    zip.outputStream.destroy();
    if(outputHandle){await outputHandle.close().catch(()=>{});await fsp.rm(temp,{force:true});}
    throw error;
  } finally { for(const stream of streams)stream.destroy(); }
}

async function assertNoLinks(root,relative) {
  let current=root;
  if((await fsp.lstat(root)).isSymbolicLink())throw new Error('Source instance cannot be a symbolic link.');
  for(const segment of relative.split('/')) {
    current=path.join(current,segment);
    if((await fsp.lstat(current)).isSymbolicLink())throw new Error('Source file cannot use symbolic links: '+relative);
  }
  if(!(await fsp.stat(current)).isFile())throw new Error('Source file is not regular: '+relative);
}

async function readMrpackIndex(archive) {
  const zip=await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true,autoClose:false},(error,opened)=>error||!opened?reject(error??new Error('Cannot read mrpack')):resolve(opened)));
  try {
    return await new Promise((resolve,reject)=>{
      let index;
      zip.on('error',reject);
      zip.on('end',()=>index?resolve(index):reject(new Error('Missing modrinth.index.json')));
      zip.on('entry',entry=>{
        if(entry.fileName!=='modrinth.index.json'){zip.readEntry();return;}
        if(index || entry.uncompressedSize>16*1024*1024){reject(new Error('Duplicate/oversized mrpack index'));return;}
        zip.openReadStream(entry,(error,stream)=>{
          if(error || !stream){reject(error??new Error('Cannot open mrpack index'));return;}
          const chunks=[];let size=0;
          stream.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){stream.destroy(new Error('Oversized mrpack index'));return;}chunks.push(Buffer.from(chunk));});
          stream.once('error',reject);
          stream.once('end',()=>{try{index=JSON.parse(Buffer.concat(chunks).toString('utf8'));zip.readEntry();}catch(failure){reject(failure);}});
        });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2),values={};
  for(let index=0;index<args.length;index+=2){if(!args[index].startsWith('--') || !args[index+1])throw new Error('Arguments must be --name value pairs');values[args[index].slice(2)]=args[index+1];}
  if(!values.manifest || !values.instance || !values.output || !values.url)throw new Error('Usage: node scripts/build-install-bundle.mjs --manifest manifest.json --instance instance-folder --output bundle.zip --url https://host/bundle.zip [--mrpack cached.mrpack] [--max-bytes 48000000]');
  const metadata=await buildInstallBundle({manifestPath:values.manifest,instanceDir:values.instance,output:values.output,url:values.url,mrpackPath:values.mrpack,maxBytes:values['max-bytes']===undefined?undefined:Number(values['max-bytes'])});
  const {paths,...descriptor}=metadata.initialInstallBundle;
  console.log(JSON.stringify({output:path.resolve(values.output),initialInstallBundle:descriptor,pathCount:paths?.length,fileCount:metadata.fileCount,uncompressedBytes:metadata.uncompressedBytes,compression:metadata.compression,maxActiveSourceStreams:metadata.maxActiveSourceStreams,maxBytes:metadata.maxBytes,excludedLargeFileCount:metadata.excludedLargeFileCount},null,2));
}
