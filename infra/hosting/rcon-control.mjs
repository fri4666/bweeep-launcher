import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {rconCommand} from "/home/dev/servers/bweeep-gate/server-gate.mjs";
const units=["bweeep-cobblebox-weekday","bweeep-cobbleverse-fabric"];
const action=process.argv[2];
if(!["prepare","resume"].includes(action))throw new Error("Invalid save action");
if(action==="prepare"){execFileSync("systemd-run",["--collect","--unit=bweeep-host-sync-saveon","--on-active=20m","/opt/node-v24.18.0/bin/node","/usr/local/lib/bweeep-hosting/rcon-control.mjs","resume"],{stdio:"ignore"});}
const uid=execFileSync("id",["-u","dev"],{encoding:"utf8"}).trim();
for(const unit of units){
 let active=false;
 try{active=execFileSync("runuser",["-u","dev","--","env","XDG_RUNTIME_DIR=/run/user/"+uid,"systemctl","--user","is-active",unit+".service"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()==="active";}catch{}
 if(!active)continue;
 const server=JSON.parse(fs.readFileSync("/home/dev/servers/bweeep-gate/"+unit+".json")).servers[0];
 for(const cmd of action==="prepare"?["save-off","save-all flush"]:["save-on"]){
  if(await rconCommand(server.rcon.port,server.rcon.password,cmd,120000)===null)throw new Error("Save control failed for "+unit);
 }
}
if(action==="resume"){try{execFileSync("systemctl",["stop","bweeep-host-sync-saveon.timer"],{stdio:"ignore"});}catch{}}
