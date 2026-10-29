import fs from "node:fs";
export function hostApi(config){
 const env={};
 for(const line of fs.readFileSync(config.credentialsFile,"utf8").split(/\r?\n/)){
  const at=line.indexOf("=");if(at>0)env[line.slice(0,at)]=line.slice(at+1).replace(/^["']|["']$/g,"");
 }
 return async(name,args)=>{
  const r=await fetch(env.SUPABASE_URL+"/rest/v1/rpc/"+name,{method:"POST",headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json"},body:JSON.stringify(args),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error("Coordinator request failed: "+r.status);
  return r.json();
 };
}
