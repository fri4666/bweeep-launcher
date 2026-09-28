import { launchGameName } from "./launch-name.ts";
import { decodeBase64, validateSkinPng } from "./skin-image.ts";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([0x49, 0x45, 0x4e, 0x44], bytes.length - 8);
  return bytes;
}

Deno.test("accepts 64x64 and legacy 64x32 skins only", () => {
  if (validateSkinPng(png(64, 64)) !== null || validateSkinPng(png(64, 32)) !== null) {
    throw new Error("Standard skin sizes must be accepted.");
  }
  if (validateSkinPng(png(128, 128)) === null || validateSkinPng(png(64, 48)) === null) {
    throw new Error("Other sizes must be rejected.");
  }
  if (validateSkinPng(new TextEncoder().encode("not a png at all, just some text here")) === null) {
    throw new Error("Non-PNG data must be rejected.");
  }
  const truncated = png(64, 64).subarray(0, 40);
  if (validateSkinPng(truncated) === null) throw new Error("A PNG without IEND must be rejected.");
  if (validateSkinPng(new Uint8Array(64 * 1024 + 1)) === null) throw new Error("Oversized files must be rejected.");
});

Deno.test("decodes strict base64 only", () => {
  if (decodeBase64("iVBORw==")?.length !== 4) throw new Error("Valid base64 was not decoded.");
  if (decodeBase64("not base64!") !== null || decodeBase64("abc") !== null) {
    throw new Error("Malformed base64 must be rejected.");
  }
});

Deno.test("derives the same game name as the launcher", async () => {
  const user = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", email: null, user_metadata: { full_name: "Seo Py!", user_name: "seos_py" } };
  if (await launchGameName(user, "Saved_Name") !== "Saved_Name") throw new Error("A saved game name wins.");
  if (await launchGameName(user, null) !== "SeoPy") throw new Error("The Discord display name comes next.");
  const korean = { ...user, user_metadata: { full_name: "나원", user_name: "나원" } };
  // Node: md5("OfflinePlayer:0f8fad5b-d9cb-469f-a165-70867728950e"), first 10 hex chars.
  const expected = "Bweep_0cdc15c550";
  const actual = await launchGameName(korean, null);
  if (actual !== expected) throw new Error(`Names without ASCII fall back to the account digest, got ${actual}.`);
});
