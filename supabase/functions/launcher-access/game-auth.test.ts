import { getLauncherVersion, isLauncherAtLeast, MIN_YGGDRASIL_LAUNCHER } from "./authorization.ts";
import { launchGameName } from "./launch-name.ts";
import { crc32, decodeBase64, validateSkinPng } from "./skin-image.ts";

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real RGBA PNG, optionally with extra chunks or a wrong pixel count. */
async function png(width: number, height: number, options: { extra?: Uint8Array; rowBytes?: number } = {}): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const pixels = new Uint8Array(height * (1 + (options.rowBytes ?? width * 4)));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(options.extra ? [options.extra] : []),
    chunk("IDAT", await deflate(pixels)),
    chunk("IEND", new Uint8Array())
  ];
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

Deno.test("accepts 64x64 and legacy 64x32 skins only", async () => {
  if (await validateSkinPng(await png(64, 64)) !== null || await validateSkinPng(await png(64, 32)) !== null) {
    throw new Error("Standard skin sizes must be accepted.");
  }
  if (await validateSkinPng(await png(128, 128)) === null || await validateSkinPng(await png(64, 48)) === null) {
    throw new Error("Other sizes must be rejected.");
  }
  if (await validateSkinPng(new TextEncoder().encode("not a png at all, just some text here but longer than fifty-seven bytes")) === null) {
    throw new Error("Non-PNG data must be rejected.");
  }
  const valid = await png(64, 64);
  if (await validateSkinPng(valid.subarray(0, valid.length - 12)) === null) throw new Error("A PNG without IEND must be rejected.");
  if (await validateSkinPng(new Uint8Array(64 * 1024 + 1)) === null) throw new Error("Oversized files must be rejected.");
});

Deno.test("skins can hold nothing but the picture", async () => {
  const text = chunk("tEXt", new TextEncoder().encode("Comment\0hidden payload"));
  if (await validateSkinPng(await png(64, 64, { extra: text })) === null) throw new Error("Text chunks must be rejected.");
  if (await validateSkinPng(await png(64, 64, { rowBytes: 64 * 4 + 100 })) === null) {
    throw new Error("Pixel data larger than the image must be rejected.");
  }
  const corrupt = await png(64, 64);
  corrupt[20] ^= 0xff;
  if (await validateSkinPng(corrupt) === null) throw new Error("A chunk with a wrong CRC must be rejected.");
});

Deno.test("only launchers from 0.1.35 on may open yggdrasil servers", () => {
  const request = (version?: string) => new Request("https://x", { headers: version ? { "x-bweeep-launcher-version": version } : {} });
  const ok = (version?: string) => isLauncherAtLeast(getLauncherVersion(request(version)), MIN_YGGDRASIL_LAUNCHER);
  if (ok() || ok("0.1.34") || ok("0.0.99") || ok("garbage")) throw new Error("Old or missing versions must be refused.");
  if (!ok("0.1.35") || !ok("0.1.35-test.2") || !ok("0.1.36") || !ok("0.2.0") || !ok("1.0.0")) {
    throw new Error("0.1.35 and newer must be accepted.");
  }
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
