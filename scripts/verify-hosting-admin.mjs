import {parseAdminRequest,handleAdminRequest} from "../supabase/functions/launcher-access/admin.ts";
import assert from "node:assert/strict";
const policy={primaryNode:"vps",automatic:false,failureSeconds:90,syncMinutes:5,maxSnapshotMinutes:10,allowRecovery:false};
assert.ok(parseAdminRequest({action:"configureHosting",policy,revision:1}));
for(const p of [{...policy,automatic:true},{...policy,failureSeconds:89},{...policy,syncMinutes:11},{...policy,maxSnapshotMinutes:1.2},{...policy,extra:1}]){
 assert.equal(parseAdminRequest({action:"configureHosting",policy:p,revision:1}),null);
}
const actor="00000000-0000-4000-8000-000000000001";
let calls=[];
const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:{activeNode:"vps"},error:null};}};
await handleAdminRequest(db,actor,{action:"adminHosting"});
assert.equal(calls[0][0],"launcher_host_admin");assert.equal(calls[0][1].p_actor,actor);assert.equal(calls[0][1].p_action,"read");
const refused={rpc:async()=>({data:null,error:{message:"NOT_ADMIN"}})};
const r=await handleAdminRequest(refused,actor,{action:"adminHosting"});
assert.equal(r.status,403);
console.log("Hosting admin: strict policy validation, verified actor RPC, database rejection PASS");
