import { createHash } from "node:crypto";
import { installerResponse } from "./index.ts";

Deno.test("serves the signed installer parts as one direct exe download", async () => {
  const first = new Uint8Array(5 * 1024 * 1024).fill(42);
  const second = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(first).update(second).digest("hex");
  const paths: string[] = [];
  const fetcher = ((url: string) => {
    paths.push(url);
    return Promise.resolve(new Response(paths.length === 1 ? first : second));
  }) as typeof fetch;
  const response = await installerResponse({ version: "0.1.40", arch: "x64", size: first.length + second.length, sha256, chunks: 2 }, fetcher);
  if (response.status !== 200 || response.headers.get("content-type") !== "application/octet-stream" ||
      response.headers.get("content-disposition") !== 'attachment; filename="Bweeep-Setup-0.1.40.exe"' ||
      response.headers.get("content-length") !== String(first.length + second.length)) {
    throw new Error("The URL must immediately return an exe attachment with its exact size");
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(downloaded).digest("hex") !== sha256 || paths.length !== 2 ||
      !paths[0].endsWith("/part-0000.bin") || !paths[1].endsWith("/part-0001.bin")) {
    throw new Error("The streamed installer differs from its signed manifest");
  }
});

Deno.test("rejects a missing first part before starting a download", async () => {
  const fetcher = (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
  let rejected = false;
  try {
    await installerResponse({ version: "0.1.40", arch: "arm64", size: 1, sha256: "0".repeat(64), chunks: 1 }, fetcher);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("A missing first part must not return a download response");
});

Deno.test("fails the download if a part does not match the signed checksum", async () => {
  const fetcher = (() => Promise.resolve(new Response(new Uint8Array([9])))) as typeof fetch;
  const response = await installerResponse({ version: "0.1.40", arch: "x64", size: 1, sha256: "0".repeat(64), chunks: 1 }, fetcher);
  let rejected = false;
  try {
    await response.arrayBuffer();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("A corrupt part must fail the installer download");
});
