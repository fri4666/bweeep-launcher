#!/usr/bin/env bash
# Verify the group migration and invite redemption in a disposable Postgres container.
set -euo pipefail
cd "$(dirname "$0")/.."
container="bweeep-groups-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
image=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^postgres:' | head -1 || true)
image=${image:-postgres:17-alpine}
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=pw -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
ready=0
for _ in $(seq 1 90); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'Postgres did not start'; exit 1; }
run() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q; }
run <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
SQL
run < supabase/migrations/20260914142631_launcher_access.sql
run <<'SQL'
insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004');
insert into public.launcher_members (user_id) values ('00000000-0000-0000-0000-000000000001');
insert into public.launcher_invites (code_hash, created_by, expires_at) values
  ('old', '00000000-0000-0000-0000-000000000001', now() + interval '1 day');
SQL
run < supabase/migrations/20261019000000_launcher_groups.sql
run <<'SQL'
do $$
begin
  if (select group_id from public.launcher_members where user_id = '00000000-0000-0000-0000-000000000001') <> 'original' then
    raise exception 'existing member was not kept in original group';
  end if;
  if (select group_id from public.launcher_invites where code_hash = 'old') <> 'original' then
    raise exception 'existing invite was not kept in original group';
  end if;
end $$;
insert into public.launcher_invites (code_hash, created_by, expires_at, group_id) values
  ('friend-a', '00000000-0000-0000-0000-000000000001', now() + interval '1 day', 'friend-a');
do $$
declare redeemed record;
begin
  select * into redeemed from public.redeem_launcher_invite('old', '00000000-0000-0000-0000-000000000002');
  if not redeemed.ok then raise exception 'old invite failed'; end if;
  select * into redeemed from public.redeem_launcher_invite('friend-a', '00000000-0000-0000-0000-000000000003');
  if not redeemed.ok then raise exception 'new invite failed'; end if;
  if (select group_id from public.launcher_members where user_id = '00000000-0000-0000-0000-000000000002') <> 'original' then
    raise exception 'old invite assigned wrong group';
  end if;
  if (select group_id from public.launcher_members where user_id = '00000000-0000-0000-0000-000000000003') <> 'friend-a' then
    raise exception 'new invite assigned wrong group';
  end if;
  if (select uses from public.launcher_invites where code_hash = 'friend-a') <> 1 then
    raise exception 'new invite usage was not counted';
  end if;
  begin
    insert into public.launcher_members (user_id, group_id) values ('00000000-0000-0000-0000-000000000004', 'unknown');
    raise exception 'invalid group was accepted';
  exception when check_violation then null;
  end;
end $$;
SQL
echo 'launcher groups: SQL checks passed'
