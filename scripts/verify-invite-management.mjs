// Actual PostgreSQL transactions in a disposable private database. Uses a new
// Docker container by default; PG_BINDIR opts into a separately supplied local
// runtime. Never connects to a configured Supabase project or existing server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bweeep-invites-"));
const container = `bweeep-invites-${randomUUID()}`;
const bin = process.env.PG_BINDIR;
let started = false;
let port;
function run(command, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()} ${stdout.trim()}`));
    });
    child.stdin.end(input);
  });
}
function sql(input) {
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", "postgres"];
  return bin
    ? run(path.join(bin, "psql"), [...args, "-h", "127.0.0.1", "-p", String(port)], input)
    : run("docker", ["exec", "-i", container, "psql", ...args], input);
}
async function waitFor(query) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await sql(query) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${query}`);
}
const member = "00000000-0000-0000-0000-000000000001";
const admin = "00000000-0000-0000-0000-000000000002";
const other = "00000000-0000-0000-0000-000000000003";
const outsider = "00000000-0000-0000-0000-000000000004";
const create = (user, hash, uses = 1) => sql(`set role service_role; select row_to_json(created) from public.launcher_create_invite('${user}', '${hash}', ${uses}) as created;`);

try {
  if (bin) {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const initArgs = ["-D", path.join(temporary, "data"), "--no-locale", "--encoding=UTF8", "--auth=trust", "-U", "postgres", "--no-sync"];
    if (process.env.PG_SHAREDIR) initArgs.push("-L", process.env.PG_SHAREDIR);
    await run(path.join(bin, "initdb"), initArgs);
    await run(path.join(bin, "pg_ctl"), ["-D", path.join(temporary, "data"), "-l", path.join(temporary, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ''`, "-w", "start"]);
    started = true;
  } else {
    await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    started = true;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
      catch (error) { if (Date.now() > deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    insert into auth.users values ('${member}'), ('${admin}'), ('${other}'), ('${outsider}');`);
  await sql(fs.readFileSync(path.join(root, "supabase/migrations/20260914142631_launcher_access.sql"), "utf8"));
  await sql(fs.readFileSync(path.join(root, "supabase/migrations/20260928003500_grant_launcher_invite_management.sql"), "utf8"));
  // Exercise the repository's actual removal trigger with only its unrelated
  // token/name tables stubbed; deleting a locked creator revokes their codes.
  await sql(["launcher_environment_access", "launcher_game_auth_tokens", "launcher_yggdrasil_joins", "launcher_game_tickets", "launcher_game_sessions"]
    .map((table) => `create table public.${table} (user_id uuid);`).join("\n")
    + "create table public.launcher_removed_members (user_id uuid primary key, removed_at timestamptz);");
  const removalSource = fs.readFileSync(path.join(root, "supabase/migrations/20260929120000_relax_name_lock.sql"), "utf8")
    .match(/create or replace function public\.launcher_member_removed\(\)[\s\S]*?\n\$\$;/)?.[0];
  assert.ok(removalSource);
  await sql(removalSource + "\ncreate trigger launcher_members_removed after delete on public.launcher_members for each row execute function public.launcher_member_removed();");
  // Supabase's standard service-role insert grant and an existing deployment
  // extension stand in for the pre-migration state, without requiring groups.
  await sql(`grant usage on schema public to anon, authenticated, service_role;
    grant insert on public.launcher_invites to service_role, public;
    grant insert(code_hash, created_by, expires_at, max_uses) on public.launcher_invites to service_role, public;
    alter table public.launcher_invites add column existing_group text default 'preserved';
    insert into public.launcher_members (user_id, role) values ('${member}', 'member'), ('${admin}', 'admin'), ('${other}', 'member');
    insert into public.launcher_invites (code_hash, created_by, expires_at, created_at)
    select 'old-' || n, '${member}', now() + interval '7 days', now() - interval '2 days' from generate_series(1,3) as n;
    insert into public.launcher_invites (code_hash, created_by, expires_at, uses)
    select 'closed-' || n, '${member}', now() + interval '7 days', 1 from generate_series(1,60) as n;`);
  assert.equal(await sql(`select count(*) from (select * from public.launcher_invites where created_by='${member}' order by created_at desc limit 50) as recent where revoked_at is null and expires_at > now() and uses < max_uses;`), "0");
  assert.equal(await sql(`select count(*) from public.launcher_invites where created_by='${member}' and uses < max_uses;`), "3");
  console.log("ok original history slice hides all three active invites");
  await sql(`delete from public.launcher_invites where created_by='${member}' and code_hash='old-3';`);
  const oldCreates = await Promise.all(["a", "b"].map((suffix) => sql(`begin; select count(*) from public.launcher_invites where created_by='${member}' and uses < max_uses; select pg_sleep(0.4); insert into public.launcher_invites(code_hash,created_by,expires_at) values('old-race-${suffix}','${member}',now()+interval '7 days'); commit;`)));
  assert.ok(oldCreates.every((output) => output.startsWith("2")), "both old requests observed room below the cap");
  assert.equal(await sql(`select count(*) from public.launcher_invites where created_by='${member}' and uses < max_uses;`), "4");
  console.log("ok original check-then-insert race exceeds the member cap");
  const migration = fs.readdirSync(path.join(root, "supabase/migrations")).find((name) => name.endsWith("_enforce_launcher_invite_limits.sql"));
  assert.ok(migration);
  await sql(fs.readFileSync(path.join(root, "supabase/migrations", migration), "utf8"));
  await assert.rejects(create(member, "over-cap"), /INVITE_LIMIT_REACHED/);
  let listing = JSON.parse(await sql(`set role service_role; select public.launcher_list_invites('${member}');`));
  assert.equal(listing.invites.length, 4, "legacy over-cap active rows remain visible");
  assert.equal(listing.activeLimit, 3);
  const oldest = await sql("select id from public.launcher_invites where code_hash='old-1';");
  assert.equal(await sql(`set role service_role; select public.launcher_revoke_invite('${other}', '${oldest}');`), "f");
  assert.equal(await sql(`set role service_role; select public.launcher_revoke_invite('${member}', '${oldest}');`), "t");
  assert.equal(await sql(`set role service_role; select public.launcher_revoke_invite('${member}', '${oldest}');`), "f");
  await assert.rejects(create(member, "still-at-cap"), /INVITE_LIMIT_REACHED/);
  await sql(`update public.launcher_invites set revoked_at=now() where code_hash='old-2';`);
  const made = JSON.parse(await create(member, "member-one", 20));
  assert.equal(made.max_uses, 1);
  assert.ok(Date.parse(made.expires_at) - Date.now() > 6.99 * 86_400_000);
  assert.ok(Date.parse(made.expires_at) - Date.now() <= 7 * 86_400_000);
  assert.equal(await sql("select existing_group from public.launcher_invites where code_hash='member-one';"), "preserved");
  await sql(`update public.launcher_invites set revoked_at=now() where created_by='${member}' and code_hash <> 'member-one';`);
  const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => create(member, `new-race-${n}`)));
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 2);
  assert.ok(concurrent.filter((result) => result.status === "rejected").every((result) => /INVITE_LIMIT_REACHED/.test(result.reason.message)));
  assert.equal(await sql(`select count(*) from public.launcher_invites where created_by='${member}' and revoked_at is null and expires_at>now() and uses<max_uses;`), "3");
  console.log("ok full-history list, owned revoke, preserved defaults, atomic concurrent member cap");
  for (const [requested, expected] of [[0, 1], [10, 10], [99, 20]]) {
    const invite = JSON.parse(await create(admin, `group-${requested}`, requested));
    assert.equal(invite.max_uses, expected);
    assert.ok(Date.parse(invite.expires_at) - Date.now() > 13.99 * 86_400_000);
  }
  await sql(`insert into public.launcher_invites(code_hash,created_by,expires_at,max_uses,uses) select 'many-'||n,'${admin}',now()+interval '14 days',20,1 from generate_series(1,1051) as n;
    insert into public.launcher_invites(code_hash,created_by,expires_at,max_uses,uses,revoked_at) values
      ('expired','${admin}',now()-interval '1 day',20,0,null),('used','${admin}',now()+interval '1 day',20,20,null),('revoked','${admin}',now()+interval '1 day',20,0,now());`);
  listing = JSON.parse(await sql(`set role service_role; select public.launcher_list_invites('${admin}');`));
  assert.equal(listing.invites.length, 1054);
  assert.equal(listing.activeLimit, null);
  assert.equal(listing.maxUsesLimit, 20);
  assert.ok(listing.invites.every((row) => !Object.hasOwn(row, "code_hash") && !Object.hasOwn(row, "existing_group")));
  console.log("ok uncapped admin group use/expiry, active SQL predicate, list beyond 1000 rows");
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(sql(`set role ${role}; select * from public.launcher_create_invite('${member}', 'forbidden', 1);`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select public.launcher_list_invites('${member}');`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select public.launcher_revoke_invite('${member}', '${oldest}');`), /permission denied/);
  }
  await assert.rejects(sql(`set role service_role; insert into public.launcher_invites(code_hash,created_by,expires_at) values('bypass','${member}',now()+interval '1 day');`), /permission denied/);
  assert.equal(await sql("select has_table_privilege('service_role', 'public.launcher_invites', 'INSERT') or has_column_privilege('service_role', 'public.launcher_invites', 'code_hash', 'INSERT');"), "f");
  assert.equal(await sql("select relrowsecurity from pg_class where oid='public.launcher_invites'::regclass;"), "t");
  assert.equal(await sql("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('launcher_create_invite','launcher_list_invites','launcher_revoke_invite') and prosecdef and proconfig @> array['search_path=\"\"'];"), "3");
  await assert.rejects(create(outsider, "not-member"), /NOT_MEMBER/);
  console.log("ok RPC grants and direct-insert bypass denial");
  await sql(`update public.launcher_members set role='admin' where user_id='${other}';`);
  const demotion = sql(`set application_name='bweeep-invite-demotion'; begin; update public.launcher_members set role='member' where user_id='${other}'; select pg_sleep(0.5); commit;`);
  await waitFor("select count(*) from pg_stat_activity where application_name='bweeep-invite-demotion' and wait_event='PgSleep';");
  assert.equal(JSON.parse(await create(other, "after-demotion", 20)).max_uses, 1);
  await demotion;
  const removal = sql(`set application_name='bweeep-invite-removal'; begin; delete from public.launcher_members where user_id='${other}'; select pg_sleep(0.5); commit;`);
  await waitFor("select count(*) from pg_stat_activity where application_name='bweeep-invite-removal' and wait_event='PgSleep';");
  await assert.rejects(create(other, "after-removal", 20), /NOT_MEMBER/);
  await removal;
  assert.equal(await sql("select revoked_at is not null from public.launcher_invites where code_hash='after-demotion';"), "t");
  console.log("ok concurrent demotion/removal precedes fresh locked policy");
  console.log("invite management: all PostgreSQL checks passed");
} finally {
  if (started) {
    if (bin) await run(path.join(bin, "pg_ctl"), ["-D", path.join(temporary, "data"), "-m", "immediate", "-w", "stop"]);
    else await run("docker", ["rm", "-f", container]);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
