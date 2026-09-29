import { isLauncherActivationLink, parseAuthCallback, parseInviteLink } from "../dist/src/main/deep-link.js";
import { isCatalogServer, isSameDocument } from "../dist/src/main/navigation.js";

const valid = parseAuthCallback("bwe-e-ep://auth/callback?code=fresh-code");
if (valid.code !== "fresh-code") throw new Error("Valid callback was rejected");
if (valid.flowId !== null) throw new Error("Unexpected flow id");

const flowAware = parseAuthCallback("bwe-e-ep://auth/callback?code=fresh-code&sb_flow_id=0123456789abcdef");
if (flowAware.flowId !== "0123456789abcdef") throw new Error("PKCE flow id was not preserved");

const testCallback = parseAuthCallback("bwe-e-ep-test://auth/callback?code=test-code", "bwe-e-ep-test");
if (testCallback.code !== "test-code") throw new Error("Test launcher callback was rejected");

if (!isLauncherActivationLink("bwe-e-ep-test://open", "bwe-e-ep-test")) {
  throw new Error("Test launcher activation link was rejected");
}
if (isLauncherActivationLink("bwe-e-ep-test://auth/callback?code=test-code", "bwe-e-ep-test")) {
  throw new Error("Authentication callback was treated as a launcher activation link");
}

const expired = new URL("bwe-e-ep://auth/callback");
expired.searchParams.set("error", "server_error");
expired.searchParams.set(
  "error_description",
  "OAuth code has expired"
);
expired.searchParams.set("sb_flow_id", "0123456789abcdef");

try {
  parseAuthCallback(expired.toString());
  throw new Error("Expired callback was accepted");
} catch (error) {
  if (!String(error.message).includes("로그인 시간이 만료되었습니다")) throw error;
  if (error.flowId !== "0123456789abcdef") throw new Error("Expired callback lost its PKCE flow id");
}

console.log("deep-link-expiry-regression=passed");

const inviteCode = "BWEEP-0123456789AB-CDEF01234567";
const parsedInvite = parseInviteLink("bwe-e-ep://invite/" + inviteCode);
if (parsedInvite !== inviteCode) throw new Error("Invite deep link was not parsed");

const parsedTestInvite = parseInviteLink("bwe-e-ep-test://invite/" + inviteCode, "bwe-e-ep-test");
if (parsedTestInvite !== inviteCode) throw new Error("Test launcher invite link was not parsed");

console.log("invite-deep-link-regression=passed");

// The window never leaves its own page, and the status check only reaches catalog servers.
const packaged = "file:///C:/Program%20Files/Bweeep/resources/app.asar/dist/renderer/index.html";
if (!isSameDocument(packaged, packaged) || !isSameDocument("http://127.0.0.1:5173/", "http://127.0.0.1:5173/")) {
  throw new Error("Reloading the launcher page must stay allowed");
}
for (const target of [
  "https://evil.example/",
  "file:///C:/Users/Public/evil.html",
  "http://127.0.0.1:8080/",
  "javascript:alert(1)",
  "not a url"
]) {
  if (isSameDocument(packaged, target) || isSameDocument("http://127.0.0.1:5173/", target)) throw new Error(`Navigation to ${target} was allowed`);
}
const catalog = [{ host: "server.fri4666.com", port: 25565 }];
if (!isCatalogServer({ host: "server.fri4666.com", port: 25565 }, catalog)) throw new Error("A catalog server was refused");
for (const server of [{ host: "192.168.0.1", port: 22 }, { host: "server.fri4666.com", port: 22 }, { host: "server.fri4666.com" }, null, "server.fri4666.com:25565"]) {
  if (isCatalogServer(server, catalog)) throw new Error(`Status check reached ${JSON.stringify(server)}`);
}

console.log("window-navigation-guard=passed");
