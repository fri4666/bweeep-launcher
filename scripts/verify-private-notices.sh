#!/usr/bin/env bash
# Runs the two notice migrations on a throwaway Postgres container and then
# scripts/verify-private-notices.sql. Stubs stand in for what Supabase provides
# (auth.users, the member table and the two admin helper functions). Nothing
# real is touched; the container is removed at the end.
#
#   bash scripts/verify-private-notices.sh
set -uo pipefail
cd "$(dirname "$0")/.."
NAME="bweeep-private-notices-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
IMG=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^postgres:' | head -1)
IMG=${IMG:-postgres:17-alpine}
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=pw -e POSTGRES_HOST_AUTH_METHOD=trust "$IMG" >/dev/null || { echo "Postgres 컨테이너를 켜지 못했습니다."; exit 2; }
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
run() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

run <<'SQL' || exit 1
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
create table public.launcher_members (user_id uuid primary key references auth.users(id) on delete cascade, role text not null, invited_at timestamptz default now());
create table public.launcher_admin_actions (id bigserial primary key, actor_id uuid, action text, target text, detail jsonb, created_at timestamptz default now());
create or replace function public.launcher_require_admin(p_actor uuid) returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.launcher_members as member where member.user_id = p_actor and member.role = 'admin') then
    raise exception using errcode = 'P0001', message = 'NOT_ADMIN';
  end if;
end; $$;
create or replace function public.launcher_log_admin_action(p_actor uuid, p_action text, p_target text, p_detail jsonb) returns void language sql security definer set search_path = '' as $$
  insert into public.launcher_admin_actions (actor_id, action, target, detail) values (p_actor, p_action, p_target, coalesce(p_detail, '{}'::jsonb));
$$;
SQL

# The state of production before this change: the first notice migration, plus a notice posted the old way.
run < supabase/migrations/20261004100000_add_launcher_notices.sql || exit 1
run <<'SQL' || exit 1
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'),('00000000-0000-0000-0000-00000000000b'),('00000000-0000-0000-0000-00000000000c');
insert into public.launcher_members (user_id, role) values ('00000000-0000-0000-0000-00000000000a','admin'),('00000000-0000-0000-0000-00000000000b','member');
select * from public.launcher_admin_set_notice(p_actor => '00000000-0000-0000-0000-00000000000a', p_body => '옛 공지');
SQL
run < supabase/migrations/20261012120000_add_private_notices.sql || exit 1
OUTPUT=$(run < scripts/verify-private-notices.sql 2>&1)
STATUS=$?
echo "$OUTPUT" | grep -E "passed:|FAILED|ERROR" || true
if [ "$STATUS" -eq 0 ] && echo "$OUTPUT" | grep -q "all private-notice checks passed"; then
  echo "private notices: SQL checks passed"
else
  echo "private notices: SQL checks FAILED"
  exit 1
fi
