import fsp from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const [version, channel, file] = process.argv.slice(2);
if (!file || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version ?? "") ||
    !["stable", "beta"].includes(channel)) {
  throw new Error("usage: publish-release-notes <version> <stable|beta> <release-notes-file>");
}
const key = process.env.SUPABASE_SECRET_KEY;
if (!key) throw new Error("SUPABASE_SECRET_KEY is required");
const client = createClient("https://tmwvrglzjfzauuygofpp.supabase.co", key, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const bucket = client.storage.from("bweeep-launcher-updates");
const objectPath = "metadata/patch-notes.json";
const current = await bucket.download(objectPath);
let releases = [];
if (!current.error && current.data) {
  const parsed = JSON.parse(await current.data.text());
  if (!Array.isArray(parsed)) throw new Error("existing patch notes are malformed");
  releases = parsed;
} else {
  if (current.error && String(current.error.statusCode) !== "404") {
    throw new Error(`cannot read current patch notes: ${current.error.message}`);
  }
  // Seed the historical notes once, while the old public GitHub update path
  // still exists. The client only reads this Supabase copy afterward.
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch("https://api.github.com/repos/fri4666/bweeep-launcher/releases?per_page=40", { headers });
  if (!response.ok) throw new Error(`cannot seed historical patch notes: ${response.status}`);
  releases = (await response.json()).filter((item) => !item.draft).map((item) => ({
    tag_name: item.tag_name,
    body: item.body,
    draft: false,
    prerelease: item.prerelease,
    published_at: item.published_at,
    html_url: null
  }));
}
const body = await fsp.readFile(file, "utf8");
const next = {
  tag_name: `v${version}`,
  body,
  draft: false,
  prerelease: channel === "beta",
  published_at: new Date().toISOString(),
  html_url: null
};
releases = [next, ...releases.filter((item) => item.tag_name !== next.tag_name)].slice(0, 40);
const result = await bucket.upload(objectPath, Buffer.from(JSON.stringify(releases)), {
  contentType: "application/json", upsert: true, cacheControl: "0"
});
if (result.error) throw new Error(`patch notes upload failed: ${result.error.message}`);
console.log(`Published patch notes for ${version}`);
