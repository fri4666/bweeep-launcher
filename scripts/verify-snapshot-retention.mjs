import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pruneSnapshots} from "../infra/hosting/prune-snapshots.mjs";

const games = ["cobblebox-weekday-fabric-1.7.42", "cobbleverse-fabric-1.7.42"];
const id = n => "snap-" + String(n).padStart(13, "0");
const record = n => ({snapshotId:id(n),snapshotSource:"vps",snapshotEpoch:8});
let checks=0;
async function fixture(test) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"bweeep-retention-"));
 const snapshot=async(n,{incomplete=false}={})=>{
  const dir=path.join(root,id(n));
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"metadata.json"),JSON.stringify({id:id(n),source:"vps",epoch:8}));
  if(!incomplete)for(const game of games){
   const world=path.join(dir,"servers",game,"world");
   await fs.mkdir(world,{recursive:true});await fs.writeFile(path.join(world,"level.dat"),"world-"+n);
  }
 };
 const latest=async(n)=>{
  await fs.rm(path.join(root,"latest"),{force:true});
  await fs.symlink(path.join(root,id(n)),path.join(root,"latest"));
 };
 try {await test({root,snapshot,latest});checks++;}
 finally {await fs.rm(root,{recursive:true,force:true});}
}
await fixture(async({root,snapshot,latest})=>{
 for(const n of [1,2,3])await snapshot(n);await latest(3);
 const result=await pruneSnapshots(root,record(3));
 assert.equal(result.olderSnapshots,2);
 assert.deepEqual((await fs.readdir(root)).sort(),["latest",id(3)]);
 assert.equal(await fs.readFile(path.join(root,id(3),"servers",games[0],"world","level.dat"),"utf8"),"world-3");
 assert.equal((await pruneSnapshots(root,record(3))).olderSnapshots,0);
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2,{incomplete:true});await latest(2);
 await assert.rejects(pruneSnapshots(root,record(2)),/ENOENT|incomplete/);
 assert.ok(await fs.stat(path.join(root,id(1))));
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2);await latest(2);
 const p=path.join(root,id(2),"metadata.json");
 await fs.writeFile(p,JSON.stringify({id:id(2),source:"pc",epoch:8}));
 await assert.rejects(pruneSnapshots(root,record(2)),/metadata differs/);
 assert.ok(await fs.stat(path.join(root,id(1))));
});
await fixture(async({root,snapshot,latest})=>{
 for(const n of [1,2,3,4])await snapshot(n);await latest(4);
 await pruneSnapshots(root,record(3));
 assert.deepEqual((await fs.readdir(root)).sort(),["latest",id(3),id(4)]);
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(2);await latest(2);
 const external=await fs.mkdtemp(path.join(os.tmpdir(),"bweeep-outside-"));
 try{
  await fs.writeFile(path.join(external,"keep.txt"),"untouched");
  await fs.symlink(external,path.join(root,id(1)));
  await pruneSnapshots(root,record(2));
  assert.equal(await fs.readFile(path.join(external,"keep.txt"),"utf8"),"untouched");
  assert.ok((await fs.lstat(path.join(root,id(1)))).isSymbolicLink());
 }finally{await fs.rm(external,{recursive:true});}
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2);await latest(2);
 await fs.rm(path.join(root,"latest"));await fs.symlink(os.tmpdir(),path.join(root,"latest"));
 await assert.rejects(pruneSnapshots(root,record(2)),/escaped/);
 assert.ok(await fs.stat(path.join(root,id(1))));
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2);await latest(2);
 for(const name of ["retained-original","incoming","incoming-"+id(3),id(3)])await fs.mkdir(path.join(root,name));
 await pruneSnapshots(root,record(2));
 for(const name of ["retained-original","incoming","incoming-"+id(3),id(3)])assert.ok(await fs.stat(path.join(root,name)));
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2);await latest(2);
 const relative=path.join("servers",games[0],"world","level.dat");
 await fs.rm(path.join(root,id(2),relative));
 await fs.link(path.join(root,id(1),relative),path.join(root,id(2),relative));
 const before=await fs.readFile(path.join(root,id(2),relative));
 await pruneSnapshots(root,record(2));
 assert.deepEqual(await fs.readFile(path.join(root,id(2),relative)),before);
});
await fixture(async({root,snapshot,latest})=>{
 await snapshot(1);await snapshot(2);await latest(2);
 await assert.rejects(pruneSnapshots(root,{...record(2),snapshotId:"../outside"}),/No acknowledged/);
 const result=await pruneSnapshots(root,record(2),{dryRun:true});
 assert.equal(result.olderSnapshots,1);assert.ok(await fs.stat(path.join(root,id(1))));
});
console.log(JSON.stringify({checks,passed:true}));
