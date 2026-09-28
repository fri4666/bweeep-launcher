#!/usr/bin/env node
// Prints the SQL that ties a server's existing players to launcher members,
// before that server switches to the Bweeep Yggdrasil API. Run it for every
// server that has world data, whatever its version or loader.
//
//   node scripts/server-identity-import.mjs <server>/usercache.json owners.json > identities.sql
//
// owners.json:
//   {
//     "source": "vanilla-26.3-survival usercache 2026-09-28",
//     "owners": [
//       { "userId": "<auth user id>", "primary": "seos_py", "names": ["seos_py", "nawon"] }
//     ]
//   }
//
// - Every UUID in the usercache is reserved: for the member who owns the
//   name, or for nobody when no member is named. Nobody else can receive it.
// - A member's `primary` name becomes their Minecraft account now, with the
//   UUID that already holds their character, inventory and OP status.
// - Their saved launcher name is set to that name, so the game shows the
//   name they already play under rather than one saved but never used.
// The SQL only adds what is missing; running it twice changes nothing.
import crypto from "node:crypto";
import fs from "node:fs";

const [usercachePath, ownersPath] = process.argv.slice(2);
if (!usercachePath || !ownersPath) {
  console.error("usage: node scripts/server-identity-import.mjs <usercache.json> <owners.json>");
  process.exit(2);
}

const usercache = JSON.parse(fs.readFileSync(usercachePath, "utf8"));
const { source, owners } = JSON.parse(fs.readFileSync(ownersPath, "utf8"));
const namePattern = /^[A-Za-z0-9_]{1,16}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (typeof source !== "string" || !source.trim()) throw new Error("owners.json needs a source");

/** Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name), what offline servers use. */
function offlineUuid(name) {
  const hash = crypto.createHash("md5").update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ownerByName = new Map();
for (const owner of owners) {
  if (!uuidPattern.test(owner.userId)) throw new Error(`bad userId ${owner.userId}`);
  for (const name of owner.names) {
    if (ownerByName.has(name.toLowerCase())) throw new Error(`${name} is listed for two members`);
    ownerByName.set(name.toLowerCase(), owner.userId);
  }
  if (!owner.names.includes(owner.primary)) throw new Error(`${owner.primary} must be one of ${owner.userId}'s names`);
}

const sql = (value) => value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const lines = ["begin;"];
const cached = new Map();
for (const entry of usercache) {
  if (!namePattern.test(entry.name) || !uuidPattern.test(entry.uuid)) throw new Error(`bad usercache entry ${JSON.stringify(entry)}`);
  // An online-mode server's cache holds Mojang UUIDs; those are not the offline data this imports.
  if (offlineUuid(entry.name) !== entry.uuid) throw new Error(`${entry.name} is not an offline-mode UUID (${entry.uuid})`);
  cached.set(entry.name.toLowerCase(), entry.uuid);
  const owner = ownerByName.get(entry.name.toLowerCase()) ?? null;
  lines.push(`insert into public.launcher_minecraft_uuid_reservations (minecraft_uuid, game_name, user_id, source) values (${sql(entry.uuid)}, ${sql(entry.name)}, ${sql(owner)}, ${sql(source)}) on conflict (minecraft_uuid) do nothing;`);
}
for (const owner of owners) {
  const uuid = cached.get(owner.primary.toLowerCase());
  if (!uuid) throw new Error(`${owner.primary} has never played on this server; leave it out or add the name the member actually used`);
  lines.push(`insert into public.launcher_minecraft_accounts (user_id, minecraft_uuid, game_name) values (${sql(owner.userId)}, ${sql(uuid)}, ${sql(owner.primary)}) on conflict do nothing;`);
  for (const name of owner.names) {
    if (name.length >= 2) lines.push(`insert into public.launcher_game_name_history (user_id, game_name) values (${sql(owner.userId)}, ${sql(name)}) on conflict do nothing;`);
  }
  if (owner.primary.length >= 3) {
    lines.push(`insert into public.launcher_profiles (user_id, game_name) values (${sql(owner.userId)}, ${sql(owner.primary)}) on conflict (user_id) do update set game_name = excluded.game_name, updated_at = now() where public.launcher_profiles.game_name is distinct from excluded.game_name;`);
  }
}
lines.push("commit;");
console.log(lines.join("\n"));
