import net from "node:net";
import fs from "node:fs";
const [node,config]=process.argv.slice(2);
if(!["vps","pc"].includes(node))throw new Error("Invalid node");
const host=node==="pc"?"158.247.246.225":"server.fri4666.com";
for(const s of JSON.parse(fs.readFileSync(config)).servers){
 net.createServer(client=>{
  const peer=net.connect({host,port:s.listen});
  client.on("error",()=>peer.destroy());peer.on("error",()=>client.destroy());
  client.on("close",()=>peer.destroy());peer.on("close",()=>client.destroy());
  client.pipe(peer).pipe(client);
 }).listen(s.listen);
}
