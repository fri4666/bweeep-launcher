import {
  apiMetadata,
  generateSigningKeyPair,
  importSigningKey,
  importVerifyKey,
  parseRoute,
  routeAudience,
  serializeProfile,
  texturesValue,
  toSignedUuid,
  toUnsignedUuid
} from "./protocol.ts";

const publicUrl = "https://example.supabase.co";
const row = {
  minecraft_uuid: "0f8fad5b-d9cb-469f-a165-70867728950e",
  game_name: "Steve_01",
  texture_hash: "a".repeat(64),
  model: "slim" as const
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("routes authlib-injector paths below the function name", () => {
  assert(parseRoute("GET", "/yggdrasil").kind === "metadata", "root is metadata");
  assert(parseRoute("GET", "/functions/v1/yggdrasil/").kind === "metadata", "prefixed root is metadata");
  assert(parseRoute("POST", "/yggdrasil/sessionserver/session/minecraft/join").kind === "join", "join");
  assert(parseRoute("GET", "/yggdrasil/sessionserver/session/minecraft/hasJoined").kind === "hasJoined", "hasJoined");
  const profile = parseRoute("GET", "/yggdrasil/sessionserver/session/minecraft/profile/0f8fad5bd9cb469fa16570867728950e");
  assert(profile.kind === "profile" && profile.id === "0f8fad5bd9cb469fa16570867728950e", "profile id");
  assert(parseRoute("POST", "/yggdrasil/api/profiles/minecraft").kind === "profilesByName", "batch lookup");
  const byName = parseRoute("GET", "/yggdrasil/api/users/profiles/minecraft/Steve_01");
  assert(byName.kind === "profileByName" && byName.name === "Steve_01", "single lookup");
  assert(parseRoute("GET", "/yggdrasil/sessionserver/session/minecraft/join").kind === "notFound", "wrong method");
  assert(parseRoute("GET", "/yggdrasil/authserver/authenticate").kind === "notFound", "password login is not offered");
});

Deno.test("a /testers root serves the same API for test servers", () => {
  assert(parseRoute("GET", "/functions/v1/yggdrasil/testers/").kind === "metadata", "tester root is metadata");
  assert(parseRoute("GET", "/yggdrasil/testers/sessionserver/session/minecraft/hasJoined").kind === "hasJoined", "tester hasJoined");
  assert(routeAudience("/functions/v1/yggdrasil/testers/sessionserver/session/minecraft/hasJoined") === "testers", "tester audience");
  assert(routeAudience("/functions/v1/yggdrasil/sessionserver/session/minecraft/hasJoined") === "members", "member audience");
  // A player named "testers" is still looked up by name on the member root.
  const byName = parseRoute("GET", "/yggdrasil/api/users/profiles/minecraft/testers");
  assert(byName.kind === "profileByName" && byName.name === "testers", "name lookup");
});

Deno.test("converts between signed and unsigned UUIDs", () => {
  assert(toUnsignedUuid(row.minecraft_uuid) === "0f8fad5bd9cb469fa16570867728950e", "unsigned");
  assert(toSignedUuid("0F8FAD5BD9CB469FA16570867728950E") === row.minecraft_uuid, "signed");
});

Deno.test("advertises the public key and only the texture host", () => {
  const metadata = apiMetadata("PEM", `${publicUrl}/`);
  assert(metadata.signaturePublickey === "PEM", "public key");
  assert(metadata.skinDomains.length === 1 && metadata.skinDomains[0] === "example.supabase.co", "skin domain");
  assert(metadata.meta["feature.no_mojang_namespace"] === true, "no Mojang fallback");
});

Deno.test("encodes the skin url, slim model and profile in the textures property", () => {
  const decoded = JSON.parse(atob(texturesValue(row, publicUrl, 1234)));
  assert(decoded.timestamp === 1234, "timestamp");
  assert(decoded.profileId === "0f8fad5bd9cb469fa16570867728950e", "profile id");
  assert(decoded.profileName === "Steve_01", "profile name");
  assert(decoded.textures.SKIN.url === `${publicUrl}/storage/v1/object/public/launcher-skins/${"a".repeat(64)}.png`, "skin url");
  assert(decoded.textures.SKIN.metadata.model === "slim", "slim model");

  const classic = JSON.parse(atob(texturesValue({ ...row, model: "default" }, publicUrl, 1)));
  assert(!("metadata" in classic.textures.SKIN), "default model has no metadata");
  const none = JSON.parse(atob(texturesValue({ ...row, texture_hash: null, model: null }, publicUrl, 1)));
  assert(Object.keys(none.textures).length === 0, "no skin shows the default skin");
});

Deno.test("signs textures so the published public key verifies them", async () => {
  const pair = await generateSigningKeyPair();
  assert(pair.publicKey.startsWith("-----BEGIN PUBLIC KEY-----\n"), "PEM public key");
  const profile = await serializeProfile(row, {
    publicUrl,
    signingKey: await importSigningKey(pair.privateKey),
    withProperties: true,
    timestamp: 1
  });
  const property = profile.properties?.[0];
  assert(property?.name === "textures" && property.signature, "signed textures property");
  const binary = atob(property.signature);
  const signature = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) signature[index] = binary.charCodeAt(index);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    await importVerifyKey(pair.publicKey),
    signature,
    new TextEncoder().encode(property.value)
  );
  assert(valid, "signature verifies");

  const plain = await serializeProfile(row, { publicUrl, signingKey: null, withProperties: false });
  assert(plain.id === "0f8fad5bd9cb469fa16570867728950e" && plain.name === "Steve_01" && !plain.properties, "bare profile");
});
