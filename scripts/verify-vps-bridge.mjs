import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { UPDATE_STORAGE_ROOT } from "../dist/src/main/file-update-manifest.js";
import { UPDATE_DOWNLOAD_ROOT } from "../dist/src/main/update-delivery.js";
import { packagedAuthOrigin } from "../dist/src/main/auth-origin.js";

assert.equal(UPDATE_STORAGE_ROOT, "https://bweeep.fri4666.com/storage/v1/object/public/bweeep-launcher-updates");
assert.equal(UPDATE_DOWNLOAD_ROOT, "https://bweeep.fri4666.com/releases");
const config = JSON.parse(await fs.readFile(new URL("../resources/supabase.example.json", import.meta.url), "utf8"));
assert.equal(config.url, "https://bweeep.fri4666.com");
assert.equal(config.redirectUri, "bwe-e-ep://auth/callback");

const retired = "https://tmwvrglzjfzauuygofpp.supabase.co";
for (const origin of [retired, retired + "/"]) {
  assert.equal(packagedAuthOrigin(origin, true), "https://bweeep.fri4666.com");
  assert.equal(packagedAuthOrigin(origin, false), origin, "development config must remain explicit");
}
for (const origin of [undefined, "", "http://localhost:54321", "http://127.0.0.1:54321", "https://custom.example.invalid", retired + "/custom", retired + "?x=1", retired + "#custom", "http://tmwvrglzjfzauuygofpp.supabase.co", "https://user@tmwvrglzjfzauuygofpp.supabase.co"]) {
  assert.equal(packagedAuthOrigin(origin, true), origin, "custom/config values must remain untouched");
}

// Exercise the installed SDK's PKCE/user/refresh contracts against a local API
// fixture. All users/tokens are synthetic; no production account is contacted.
const user = { id: "11111111-2222-4333-8444-555555555555", aud: "authenticated", role: "authenticated", email: "fixture@example.invalid", app_metadata: { provider: "discord" }, user_metadata: { user_name: "fixture" }, created_at: new Date(0).toISOString() };
const encoded = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = encoded({ alg: "HS256", typ: "JWT" }) + "." + encoded({ sub: user.id, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now()/1000)+900, iat: Math.floor(Date.now()/1000) }) + ".fixture";
const grants = [];
const server = createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  const target = new URL(req.url, "http://fixture.invalid");
  res.setHeader("Content-Type", "application/json");
  if (target.pathname === "/auth/v1/token") {
    const body = JSON.parse(text); const grant = target.searchParams.get("grant_type"); grants.push(grant);
    if (grant === "pkce") { assert.equal(body.auth_code, "fixture-code"); assert.ok(body.code_verifier.length >= 43); }
    else { assert.equal(grant, "refresh_token"); assert.equal(body.refresh_token, "fixture-refresh-first"); }
    res.end(JSON.stringify({ access_token: jwt, token_type: "bearer", expires_in: 900, expires_at: Math.floor(Date.now()/1000)+900, refresh_token: grant === "pkce" ? "fixture-refresh-first" : "fixture-refresh-second", user }));
  } else if (target.pathname === "/auth/v1/user") {
    assert.equal(req.headers.authorization, "Bearer " + jwt); res.end(JSON.stringify(user));
  } else { res.statusCode = 404; res.end("{}"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const oldKey = "sb-tmwvrglzjfzauuygofpp-auth-token";
const values = new Map([[oldKey, "synthetic-old-encrypted-entry-placeholder"]]);
const storage = { getItem: async k => values.get(k) ?? null, setItem: async (k,v) => { values.set(k,v); }, removeItem: async k => { values.delete(k); } };
try {
  const client = createClient(`http://127.0.0.1:${address.port}`, "fixture-public-key", { auth: { flowType: "pkce", experimental: { appendPkceFlowIdToRedirects: true }, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage } });
  assert.equal((await client.auth.getSession()).data.session, null, "old-origin storage entry must not be silently migrated");
  const begin = await client.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: "bwe-e-ep://auth/callback", skipBrowserRedirect: true } });
  assert.equal(begin.error, null); const auth = new URL(begin.data.url); assert.equal(auth.searchParams.get("provider"), "discord");
  const callback = new URL(auth.searchParams.get("redirect_to")); assert.equal(callback.protocol, "bwe-e-ep:"); assert.equal(callback.host, "auth"); assert.equal(callback.pathname, "/callback");
  assert.match(callback.searchParams.get("sb_flow_id"), /^[a-f0-9]{32}$/i);
  assert.equal(auth.searchParams.get("code_challenge_method"), "s256"); assert.match(auth.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  const exchange = await client.auth.exchangeCodeForSession("fixture-code", { flowId: callback.searchParams.get("sb_flow_id") }); assert.equal(exchange.error, null); assert.equal(exchange.data.user.id, user.id);
  assert.equal((await client.auth.getUser()).data.user.id, user.id);
  const refresh = await client.auth.refreshSession(); assert.equal(refresh.error, null); assert.equal(refresh.data.session.refresh_token, "fixture-refresh-second");
  assert.deepEqual(grants, ["pkce", "refresh_token"]); assert.equal(values.get(oldKey), "synthetic-old-encrypted-entry-placeholder", "old stored entry must remain untouched");
  client.auth.stopAutoRefresh();
} finally { await new Promise(resolve => server.close(resolve)); }
console.log("VPS bridge domain roots and installed SDK PKCE/user/refresh plus old-origin entry preservation PASS (local fixture only)");
