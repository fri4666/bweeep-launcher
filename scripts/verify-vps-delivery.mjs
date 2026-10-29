import assert from "node:assert/strict";
import { fetchUpdateArtifact, vpsArtifactUrl, UPDATE_DOWNLOAD_ROOT } from "../dist/src/main/update-delivery.js";
import { UPDATE_STORAGE_ROOT } from "../dist/src/main/file-update-manifest.js";
const source = UPDATE_STORAGE_ROOT + "/blobs/" + "a".repeat(64) + "/part-0000.bin";
assert.equal(vpsArtifactUrl(source), UPDATE_DOWNLOAD_ROOT + source.slice(UPDATE_STORAGE_ROOT.length));
for (const input of ["https://untrusted.invalid/blob",UPDATE_STORAGE_ROOT+"/channels/stable/x64.json",UPDATE_STORAGE_ROOT+"/blobs/../key",source+"?redirect=1"]) {
  assert.throws(() => vpsArtifactUrl(input));
}
for (const status of [200,403,500]) {
  const calls = [];
  const result = await fetchUpdateArtifact(source, {}, async (url, options) => {
    calls.push(url); assert.equal(options.redirect,"error");
    return new Response("body",{status});
  });
  assert.equal(result.status,status);
  assert.deepEqual(calls,[vpsArtifactUrl(source)]);
}
const calls=[];
const result=await fetchUpdateArtifact(source,{},async url=>{
  calls.push(url);
  return url.startsWith(UPDATE_DOWNLOAD_ROOT) ? new Response("missing",{status:404}) : new Response("legacy");
});
assert.equal(await result.text(),"legacy");
assert.deepEqual(calls,[vpsArtifactUrl(source),source]);
await assert.rejects(()=>fetchUpdateArtifact(source,{},async()=>{throw new Error("TLS failed");}),/TLS failed/);
console.log("VPS delivery: pinned immutable paths, no redirects, 404 legacy bridge, errors surfaced PASS");
