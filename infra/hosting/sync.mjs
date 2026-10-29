import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {hostApi} from "./api.mjs";
const run=promisify(execFile);
const config=JSON.parse(await fs.readFile(process.argv[2],"utf8"));
const direction=process.argv[3];
if(config.node!=="pc" || !["pull","push"].includes(direction))throw new Error("Invalid synchronization role");
const api=hostApi(config),state=await api("launcher_host_state",{p_cluster:config.cluster});
const source=direction==="pull"?"vps":"pc",target=direction==="pull"?"pc":"vps";
if(state.activeNode!==source)throw new Error("Source is not authoritative");
const id="snap-"+Date.now(),started=new Date().toISOString();
const sshOptions=["-o","BatchMode=yes","-o","ConnectTimeout=15","-o","UserKnownHostsFile="+config.knownHosts];
const admin=[...sshOptions,"-i",config.vpsSshKey,"root@158.247.246.225"];
const backup=[...sshOptions,"-i",config.vpsBackupKey,"root@158.247.246.225"];
const remoteShell="ssh -o BatchMode=yes -o ConnectTimeout=15 -o UserKnownHostsFile="+config.knownHosts+" -i "+(direction==="pull"?config.vpsBackupKey:config.vpsSshKey);
const root=config.standbyRoot;
await fs.mkdir(root,{recursive:true,mode:0o700});
const disk=await fs.statfs(root);if(disk.bavail*disk.bsize<20*1024**3)throw new Error("Less than 20 GiB free for safe world synchronization");
let resumeNeeded=false;
try {
 if(direction==="pull"){
  resumeNeeded=true;await run("ssh",[...backup,"prepare"],{timeout:130000});
  const incoming=path.join(root,"incoming-"+id);await fs.mkdir(path.join(incoming,"servers"),{recursive:true});
  let link=[];try{link=["--link-dest="+path.join(await fs.realpath(path.join(root,"latest")),"servers")];}catch{}
  await run("rsync",["-a","-z","--no-owner","--no-group","--delete-delay",...link,"--exclude=logs","--exclude=crash-reports","--exclude=session.lock","-e",remoteShell,"root@158.247.246.225:/home/dev/servers/",path.join(incoming,"servers")+"/"],{timeout:900000,maxBuffer:1024*1024});
  await run("ssh",[...backup,"resume"],{timeout:130000});resumeNeeded=false;
  const meta={id,source,epoch:state.epoch,at:started};
  await fs.writeFile(path.join(incoming,"metadata.json"),JSON.stringify(meta));
  const dest=path.join(root,id);await fs.rename(incoming,dest);
  const ok=await api("launcher_host_snapshot",{p_cluster:config.cluster,p_node:target,p_source:source,p_epoch:state.epoch,p_at:started,p_snapshot:id});
  if(!ok)throw new Error("Authority changed during snapshot");
  const tmp=path.join(root,"latest-new");await fs.rm(tmp,{force:true});await fs.symlink(dest,tmp);await fs.rename(tmp,path.join(root,"latest"));
 }else{
  resumeNeeded=true;
  await run("/opt/node-v24.18.0/bin/node",["/usr/local/lib/bweeep-hosting/rcon-control.mjs","prepare"],{timeout:130000});
  await run("ssh",[...admin,"mkdir -p /var/lib/bweeep-host-agent/standby/incoming/servers"],{timeout:30000});
  const remoteDisk=await run("ssh",[...admin,"df -Pk /var/lib/bweeep-host-agent/standby"],{timeout:30000});
  if(Number(remoteDisk.stdout.trim().split(/\n/).at(-1).trim().split(/\s+/)[3])<20*1024**2)throw new Error("Less than 20 GiB free on VPS standby storage");
  await run("rsync",["-a","-z","--delete-delay","--link-dest=/var/lib/bweeep-host-agent/standby/latest/servers","--exclude=logs","--exclude=crash-reports","--exclude=session.lock","-e",remoteShell,"/home/dev/servers/cobblebox-weekday-fabric-1.7.42","/home/dev/servers/cobbleverse-fabric-1.7.42","root@158.247.246.225:/var/lib/bweeep-host-agent/standby/incoming/servers/"],{timeout:900000,maxBuffer:1024*1024});
  await run("/opt/node-v24.18.0/bin/node",["/usr/local/lib/bweeep-hosting/rcon-control.mjs","resume"],{timeout:130000});resumeNeeded=false;
  const meta={id,source,epoch:state.epoch,at:started};
  const child=execFile("ssh",[...admin,"/usr/local/lib/bweeep-hosting/receive-snapshot.py"],{timeout:30000});
  child.stdin.end(JSON.stringify(meta));
  await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error("Remote snapshot commit failed")));});
  const ok=await api("launcher_host_snapshot",{p_cluster:config.cluster,p_node:target,p_source:source,p_epoch:state.epoch,p_at:meta.at,p_snapshot:id});
  if(!ok)throw new Error("Authority changed during snapshot");
 }
 console.log("WORLD_SYNC_SUCCESS",direction,id);
} finally {
 if(resumeNeeded){
  if(direction==="pull")await run("ssh",[...backup,"resume"],{timeout:130000}).catch(()=>{});
  else await run("/opt/node-v24.18.0/bin/node",["/usr/local/lib/bweeep-hosting/rcon-control.mjs","resume"],{timeout:130000}).catch(()=>{});
 }
}
