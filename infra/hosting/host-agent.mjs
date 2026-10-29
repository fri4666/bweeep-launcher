import fs from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
import {hostApi} from "./api.mjs";
const run=promisify(execFile);
export class HostAgent {
 constructor(config,io){
  this.config=config;this.api=io.api;this.driver=io.driver;this.sync=io.sync;this.write=io.write;this.now=io.now??Date.now;
  this.session=io.session;this.mode="starting";this.busy=false;this.transition=null;this.syncing=null;this.lastSync=0;this.lastGrant=0;this.proxyEpoch=null;this.latest=null;
 }
 async fence(){
  if(this.mode==="fenced")return;
  this.mode="fenced";this.proxyEpoch=null;
  await this.driver("fence");
 }
 async watchdog(){if(this.lastGrant && this.now()-this.lastGrant>12000 && ["active","activating","handoff"].includes(this.mode))await this.fence();}
 async synchronize(direction){
  if(this.syncing)return this.syncing;
  this.lastSync=this.now();
  this.syncing=this.sync(direction).finally(()=>{this.syncing=null;});
  return this.syncing;
 }
 async activate(result){
  if(this.transition)return;
  this.mode="activating";
  this.transition=(async()=>{
   await this.write({...result.state,restoreRequired:result.restoreRequired===true});
   await this.driver("activate");
   if(this.now()-this.lastGrant>12000 || this.latest?.activeNode!==this.config.node){await this.fence();return;}
   this.mode="active";this.proxyEpoch=null;await this.driver("permit");
  })().catch(async e=>{console.error("HOST_ACTIVATION_FAILED",e.message);await this.fence();}).finally(()=>{this.transition=null;});
 }
 async handoff(state){
  if(this.transition)return;
  this.mode="handoff";
  this.transition=(async()=>{
   await this.driver("fence");
   if(this.config.node==="pc"){
    await this.synchronize("push");
   }else{
    // The PC standby agent performs a fresh pull after seeing this request.
    // It must timestamp a complete snapshot after the primary stopped writing.
    const deadline=this.now()+15*60_000;
    for(;;){
     const s=await this.api("launcher_host_state",{p_cluster:this.config.cluster});
     const target=s.nodes.find(n=>n.node===s.requestedNode);
     if(target?.snapshotEpoch===s.epoch && target.snapshotSource===this.config.node && Date.parse(target.snapshotAt)>this.handoffStarted)break;
     if(this.now()>deadline)throw new Error("Standby synchronization timed out");
     await new Promise(r=>setTimeout(r,2000));
    }
   }
   this.mode="releasing";
   const released=await this.api("launcher_host_release",{p_cluster:this.config.cluster,p_node:this.config.node,p_session:this.session,p_epoch:state.epoch});
   if(!released)throw new Error("Host release rejected");
   this.mode="released";
  })().catch(async e=>{console.error("HOST_HANDOFF_FAILED",e.message);await this.fence();}).finally(()=>{this.transition=null;});
 }
 async tick(){
  if(this.busy)return;this.busy=true;
  try {
   if(["released","releasing"].includes(this.mode)){
    const s=await this.api("launcher_host_state",{p_cluster:this.config.cluster});
    this.latest=s;
    if(s.activeNode!==this.config.node || s.requestedNode===null)this.mode="standby";
    else return;
   }
   const result=await this.api("launcher_host_poll",{p_cluster:this.config.cluster,p_node:this.config.node,p_session:this.session,p_claim:true,p_status:this.mode==="active"?"active":this.syncing?"syncing":"standby"});
   this.latest=result.state;
   const s=result.state;
   if(result.granted){
    this.lastGrant=this.now();
    if(this.mode==="active"){
     await this.driver("permit");
     if(s.requestedNode && s.requestedNode!==this.config.node){
      this.handoffStarted=this.now();void this.handoff(s);
     }else if(this.config.node==="pc" && (s.nodes.find(n=>n.node==="vps")?.snapshotEpoch!==s.epoch || this.now()-this.lastSync>s.policy.syncMinutes*60000)){
      void this.synchronize("push").catch(e=>console.error("HOST_SYNC_FAILED",e.message));
     }
    }else if(!["activating","handoff"].includes(this.mode)){
     void this.activate(result);
    }
   }else{
    if(["active","activating","handoff"].includes(this.mode))await this.fence();
    if(s.activeNode!==this.config.node && Date.parse(s.leaseUntil)>Date.parse(result.serverNow)){
     if(this.proxyEpoch!==s.epoch){
      await this.driver("proxy");this.proxyEpoch=s.epoch;
     }
     this.mode="standby";await this.driver("permit");
     if(this.config.node==="pc" && !this.syncing && (s.requestedNode==="pc" || s.nodes.find(n=>n.node==="pc")?.snapshotEpoch!==s.epoch || this.now()-this.lastSync>s.policy.syncMinutes*60000)){
      void this.synchronize("pull").catch(e=>console.error("HOST_SYNC_FAILED",e.message));
     }
    }else if(this.mode!=="fenced")await this.fence();
   }
  }catch(e){
   console.error("HOST_COORDINATOR_FAILED",e.message);
   await this.watchdog();
  }finally{this.busy=false;}
 }
}
async function main(){
 const config=JSON.parse(await fs.readFile(process.argv[2],"utf8"));
 await fs.mkdir("/var/lib/bweeep-host-agent",{recursive:true,mode:0o700});
 let session;
 try{session=(await fs.readFile("/var/lib/bweeep-host-agent/session","utf8")).trim();}
 catch{session=randomUUID();await fs.writeFile("/var/lib/bweeep-host-agent/session",session,{mode:0o600});}
 const transport=hostApi(config);
 let authorization=null;
 const api=async(name,args)=>{
  const result=await transport(name,args);
  if(name==="launcher_host_poll"){
   const live=result.granted || (result.state.activeNode!==config.node && Date.parse(result.state.leaseUntil)>Date.parse(result.serverNow));
   if(live)authorization={role:result.granted?"active":"proxy",until:Number((await fs.readFile("/proc/uptime","utf8")).split(" ")[0])+12};
   else authorization=null;
  }
  return result;
 };
 const driver=async action=>{
  if(action==="permit"){
   if(!authorization)throw new Error("No current port authorization");
   await fs.writeFile("/run/bweeep-host-agent/authorization.json",JSON.stringify(authorization));
  }
  return run("/usr/local/lib/bweeep-hosting/driver.py",[process.argv[2],action],{timeout:650000,maxBuffer:1024*1024});
 };
 const agent=new HostAgent(config,{api,driver,sync:direction=>run("/opt/node-v24.18.0/bin/node",["/usr/local/lib/bweeep-hosting/sync.mjs",process.argv[2],direction],{timeout:1100000,maxBuffer:1024*1024}),write:async s=>{
  let previous;try{previous=JSON.parse(await fs.readFile(config.stateFile,"utf8"));}catch{}
  if(previous?.restoreRequired && previous.epoch===s.epoch)s.restoreRequired=true;
  await fs.writeFile(config.stateFile+".new",JSON.stringify(s));await fs.rename(config.stateFile+".new",config.stateFile);
 },session});
 await driver("init");
 await run("systemd-notify",["--ready"]);
 const poll=async()=>{await agent.tick();await run("systemd-notify",["WATCHDOG=1"]).catch(()=>{});};
 void poll();
 setInterval(()=>void poll(),5000);
 setInterval(()=>void agent.watchdog().catch(e=>console.error("HOST_FENCE_FAILED",e.message)),1000);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exit(1);});
