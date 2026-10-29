import { createHash } from "node:crypto";
import { installerResponse, githubInstallerResponse } from "./index.ts";

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

Deno.test("redirects only to the exact public GitHub installer with matching signed size and digest", async () => {
  for (const arch of ["x64", "arm64"] as const) {
    const manifest = { version: "0.1.41", arch, size: 123, sha256: "a".repeat(64), chunks: 1 };
    const filename = `Bweeep-Setup-0.1.41${arch === "arm64" ? "-arm64" : ""}.exe`;
    const url = `https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.41/${filename}`;
    const asset = { name: filename, size: 123, digest: `sha256:${manifest.sha256}`, browser_download_url: url };
    const release = { draft: false, prerelease: false, tag_name: "v0.1.41", assets: [asset] };
    const fetcher = ((address: string) => {
      if (!address.startsWith("https://api.github.com/repos/fri4666/bweeep-launcher/releases/tags/")) throw new Error("Unexpected destination");
      return Promise.resolve(Response.json(release));
    }) as typeof fetch;
    const response = await githubInstallerResponse(manifest, fetcher);
    if (response?.status !== 302 || response.headers.get("location") !== url) throw new Error("Expected verified GitHub redirect");
    for (const change of [{ digest: "sha256:" + "b".repeat(64) }, { size: 124 }, { browser_download_url: "https://example.com/file.exe" }]) {
      const wrong = (() => Promise.resolve(Response.json({ ...release, assets: [{ ...asset, ...change }] }))) as typeof fetch;
      if (await githubInstallerResponse(manifest, wrong) !== null) throw new Error("Mismatched asset must not redirect");
    }
    for (const change of [{ draft: true }, { prerelease: true }, { tag_name: "v0.1.42" }, { assets: [asset, asset] }]) {
      if (await githubInstallerResponse(manifest, (() => Promise.resolve(Response.json({ ...release, ...change }))) as typeof fetch) !== null) throw new Error("Unqualified release must not redirect");
    }
    if (await githubInstallerResponse(manifest, (() => Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch) !== null) throw new Error("Missing release must use legacy path");
  }
});
