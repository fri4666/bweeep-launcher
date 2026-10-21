// Immutable private Storage upload. Default is a local dry-run; no signed URLs or credentials are logged or saved.
import crypto from 'node:crypto';
import fs, { openAsBlob } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PROJECT='tmwvrglzjfzauuygofpp',BUCKET='bweeep-modpacks',PACK='society-sunlit-valley',MAX_BYTES=48_000_000;
async function digest(file) {
  const hash=crypto.createHash('sha512');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

export async function uploadInstallBundle({archivePath,metadataPath=archivePath+'.json',apply=false,outputPath}) {
  const metadata=JSON.parse(await fsp.readFile(metadataPath,'utf8')),source=metadata.initialInstallBundle;
  const size=(await fsp.stat(archivePath)).size;
  if(metadata.packId!==PACK || !source || !Number.isSafeInteger(size) || size<1 || size>MAX_BYTES || size!==source.size || !/^[a-f0-9]{128}$/.test(source.sha512))throw new Error('Bundle metadata/pack/48MB limit validation failed.');
  if(await digest(archivePath)!==source.sha512)throw new Error('Local bundle SHA512 validation failed.');
  const objectPath=`install-bundles/${PACK}/${source.sha512}.zip`;
  const initialInstallBundle={url:`storage://${BUCKET}/${objectPath}`,size,sha512:source.sha512,...(source.paths?{paths:source.paths}:{})};
  const plan={project:PROJECT,bucket:BUCKET,objectPath,initialInstallBundle,uploaded:false,remoteDownloadVerified:false,overwrite:false,activated:false};
  if(!apply)return {...plan,dryRun:true};
  if(!outputPath)throw new Error('An output evidence file is required before applying an upload.');
  try {await fsp.lstat(outputPath);throw new Error('Upload evidence output already exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const token=process.env.SUPABASE_ACCESS_TOKEN?.trim() || (await fsp.readFile(path.join(os.homedir(),'.supabase','access-token'),'utf8')).trim();
  const keysResponse=await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`,{headers:{Authorization:`Bearer ${token}`}});
  if(!keysResponse.ok)throw new Error('Management API credential lookup refused: HTTP '+keysResponse.status);
  const keys=await keysResponse.json(),key=Array.isArray(keys)?keys.find(item=>item.name==='service_role')?.api_key:null;
  if(typeof key!=='string' || !key)throw new Error('A service-role credential was not available.');
  const client=createClient(`https://${PROJECT}.supabase.co`,key,{auth:{persistSession:false,autoRefreshToken:false}}),bucket=client.storage.from(BUCKET);
  const {error}=await bucket.upload(objectPath,await openAsBlob(archivePath,{type:'application/zip'}),{contentType:'application/zip',cacheControl:'31536000',upsert:false});
  const exists=error && (String(error.statusCode)==='409' || /already exists/i.test(error.message??''));
  if(error && !exists)throw new Error('Private bundle upload refused: HTTP '+String(error.statusCode??'unknown'));
  const {data:signed,error:signError}=await bucket.createSignedUrl(objectPath,15*60);
  if(signError || !signed?.signedUrl)throw new Error('Private bundle verification URL could not be created.');
  let response;
  try {response=await fetch(signed.signedUrl);}catch{throw new Error('Private bundle verification network request failed.');}
  if(!response.ok || !response.body)throw new Error('Private bundle verification download failed: HTTP '+response.status);
  let downloaded=0;const hash=crypto.createHash('sha512');
  for await(const chunk of response.body){downloaded+=chunk.byteLength;if(downloaded>size)throw new Error('Private bundle verification exceeded its pinned size.');hash.update(chunk);}
  if(downloaded!==size || hash.digest('hex')!==source.sha512)throw new Error('Private bundle verification size/SHA512 mismatch.');
  const result={...plan,uploaded:!exists,reusedExistingObject:Boolean(exists),remoteDownloadVerified:true,verifiedBytes:downloaded,dryRun:false};
  if(outputPath)await fsp.writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return result;
}

if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    const args=process.argv.slice(2);let archivePath,outputPath,apply=false;
    for(let index=0;index<args.length;index++){
      if(args[index]==='--apply'){apply=true;continue;}
      if(args[index]==='--output'){outputPath=args[++index];continue;}
      if(args[index].startsWith('--') || archivePath)throw new Error('Unknown argument.');
      archivePath=args[index];
    }
    if(!archivePath)throw new Error('Usage: node scripts/upload-install-bundle.mjs bundle.zip [--apply --output private-result.json]');
    const result=await uploadInstallBundle({archivePath,outputPath,apply});
    const {initialInstallBundle,...summary}=result;
    console.log(JSON.stringify({...summary,size:initialInstallBundle.size,sha512:initialInstallBundle.sha512,pathCount:initialInstallBundle.paths?.length},null,2));
  }catch(error){console.error(error instanceof Error?error.message.replace(/https?:\/\/[^\s]+/g,'[redacted-url]'):'Private bundle operation failed.');process.exitCode=1;}
}
