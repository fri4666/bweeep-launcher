const storageRoot = "https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates";
const chunkSize = 8 * 1024 * 1024;

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function latestInstaller(arch: "x64" | "arm64") {
  const keyPemBase64 = Deno.env.get("BWEEP_UPDATE_PUBLIC_KEY_BASE64");
  if (!keyPemBase64) throw new Error("installer verification key is not configured");
  const pem = atob(keyPemBase64);
  const der = bytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
  const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  const response = await fetch(`${storageRoot}/installers/stable/${arch}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("installer manifest is unavailable");
  const manifest = await response.json();
  if (manifest.schema !== 1 || manifest.arch !== arch ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 2_000_000_000 ||
      manifest.chunkSize !== chunkSize || manifest.chunks !== Math.ceil(manifest.size / chunkSize) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.signature !== "string") {
    throw new Error("installer manifest is invalid");
  }
  const { schema, version, size, sha256, chunks } = manifest;
  const payload = { schema, version, arch, size, sha256, chunkSize, chunks };
  const trusted = await crypto.subtle.verify("Ed25519", key, bytes(manifest.signature), new TextEncoder().encode(JSON.stringify(payload)));
  if (!trusted) throw new Error("installer manifest signature is invalid");
  return payload;
}

Deno.serve(async (request) => {
  const requested = new URL(request.url).searchParams.get("arch");
  const arch = requested === "arm64" ? "arm64" : "x64";
  let manifest;
  try {
    manifest = await latestInstaller(arch);
  } catch {
    return new Response("런처 설치 파일을 아직 받을 수 없습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
  }
  const embedded = JSON.stringify(manifest).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>붸에엡 런처 받기</title>
<style>body{font:16px system-ui,sans-serif;background:#111820;color:#eef4f4;max-width:560px;margin:12vh auto;padding:24px}button{background:#7de2c1;color:#10201c;border:0;border-radius:8px;padding:14px 22px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}p{line-height:1.65;color:#b9c8ca}</style>
<h1>붸에엡 런처</h1><p>Windows ${arch === "arm64" ? "ARM64" : "x64"} · v${manifest.version}<br>설치 파일을 안전하게 모아 내려받습니다.</p>
<button id="download">설치 파일 받기</button><p id="status" role="status"></p>
<script>
const manifest=${embedded};
const root=${JSON.stringify(storageRoot)};
const button=document.getElementById('download');
const status=document.getElementById('status');
button.addEventListener('click',async()=>{
  button.disabled=true;
  const pieces=[];
  try{
    for(let part=0;part<manifest.chunks;part++){
      status.textContent='다운로드 중 '+Math.round(part/manifest.chunks*100)+'%';
      const name='part-'+String(part).padStart(4,'0')+'.bin';
      const response=await fetch(root+'/installers/'+manifest.version+'/'+manifest.arch+'/'+name,{cache:'no-store'});
      if(!response.ok)throw new Error('파일을 받을 수 없습니다.');
      pieces.push(await response.arrayBuffer());
    }
    const blob=new Blob(pieces,{type:'application/vnd.microsoft.portable-executable'});
    if(blob.size!==manifest.size)throw new Error('파일 크기가 일치하지 않습니다.');
    status.textContent='파일을 확인하고 있습니다…';
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(actual!==manifest.sha256)throw new Error('파일 검증에 실패했습니다. 다시 시도해 주세요.');
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    link.download='Bweeep-Setup-'+manifest.version+(manifest.arch==='arm64'?'-arm64':'')+'.exe';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    status.textContent='다운로드가 시작됐습니다.';
  }catch(error){status.textContent=error.message||'다운로드에 실패했습니다.';}
  finally{button.disabled=false;}
});
</script></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
    }
  });
});
