-- Checks the private-notice migration (20261012120000_add_private_notices.sql).
-- It needs auth.users, launcher_members, launcher_notices (20261004100000) and the
-- admin helper functions. Run on a throwaway database: scripts/verify-private-notices.sh
-- (a plain Postgres container) or the local Supabase stack. It writes rows.
--
-- Assumes the old-shape row the production table already holds (an everyone-notice
-- posted before this migration) and these ids:
--   ...0a admin, ...0b member, ...0c not a member.
\set ON_ERROR_STOP on

create temp table check_result (name text, ok boolean);
create or replace function pg_temp.expect(name text, ok boolean) returns void language plpgsql as $$
begin
  insert into check_result values (name, coalesce(ok, false));
  if not coalesce(ok, false) then raise exception 'FAILED: %', name; end if;
  raise notice 'passed: %', name;
end $$;

-- The call shapes launcher-access v30 uses still work and mean "everyone".
select pg_temp.expect('old call: everyone notice kept as everyone',
  (select count(*) = 1 and bool_and(target_user_id is null) from public.launcher_notices where ended_at is null));
select pg_temp.expect('old two-argument set still works',
  (select count(*) = 1 from public.launcher_admin_set_notice(p_actor => '00000000-0000-0000-0000-00000000000a', p_body => '모두에게')));
select pg_temp.expect('old call ended the previous everyone-notice and left exactly one shown',
  (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id is null));

-- A personal notice does not touch the everyone-notice.
select pg_temp.expect('personal notice is stored with its target',
  (select count(*) = 1 from public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', '너에게만', '00000000-0000-0000-0000-00000000000b')));
select pg_temp.expect('everyone-notice is still shown after a personal one',
  (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id is null and body = '모두에게'));
select pg_temp.expect('exactly one personal notice is shown for that member',
  (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id = '00000000-0000-0000-0000-00000000000b'));

-- A new personal notice ends only that member's previous one.
select pg_temp.expect('second personal notice replaces the first for the same member',
  (select count(*) = 1 from public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', '다시 너에게', '00000000-0000-0000-0000-00000000000b')));
select pg_temp.expect('only the newest personal notice is shown',
  (select count(*) = 1 and bool_and(body = '다시 너에게') from public.launcher_notices where ended_at is null and target_user_id = '00000000-0000-0000-0000-00000000000b'));
select pg_temp.expect('the replaced personal notice is kept as ended',
  (select count(*) = 1 from public.launcher_notices where ended_at is not null and target_user_id = '00000000-0000-0000-0000-00000000000b' and body = '너에게만'));

-- A new everyone-notice leaves the personal one alone.
select pg_temp.expect('a new everyone-notice posts',
  (select count(*) = 1 from public.launcher_admin_set_notice(p_actor => '00000000-0000-0000-0000-00000000000a', p_body => '새 공지')));
select pg_temp.expect('the personal notice survived the new everyone-notice',
  (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id = '00000000-0000-0000-0000-00000000000b'));

-- Clearing: by audience.
select public.launcher_admin_clear_notice(p_actor => '00000000-0000-0000-0000-00000000000a');
select pg_temp.expect('old one-argument clear ends only the everyone-notice',
  (select count(*) = 0 from public.launcher_notices where ended_at is null and target_user_id is null)
  and (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id = '00000000-0000-0000-0000-00000000000b'));
select public.launcher_admin_clear_notice('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
select pg_temp.expect('clear with a target ends that member''s notice',
  (select count(*) = 0 from public.launcher_notices where ended_at is null));
select public.launcher_admin_clear_notice('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
select pg_temp.expect('clearing when nothing is shown does nothing and does not fail', true);

-- Refusals.
do $$ begin
  perform public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', 'x', '00000000-0000-0000-0000-00000000000c');
  raise exception 'FAILED: a non-member target was accepted';
exception when others then
  if sqlerrm <> 'MEMBER_NOT_FOUND' then raise; end if;
end $$;
select pg_temp.expect('a target that is not a member is refused with MEMBER_NOT_FOUND', true);

do $$ begin
  perform public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000b', 'x');
  raise exception 'FAILED: a non-admin could post';
exception when others then
  if sqlerrm <> 'NOT_ADMIN' then raise; end if;
end $$;
select pg_temp.expect('a non-admin cannot post (everyone)', true);

do $$ begin
  perform public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000b', 'x', '00000000-0000-0000-0000-00000000000b');
  raise exception 'FAILED: a non-admin could post a personal notice';
exception when others then
  if sqlerrm <> 'NOT_ADMIN' then raise; end if;
end $$;
select pg_temp.expect('a non-admin cannot post (personal)', true);

-- Length rule still enforced by the table.
do $$ begin
  perform public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', repeat('가', 101), '00000000-0000-0000-0000-00000000000b');
  raise exception 'FAILED: an over-long personal notice was stored';
exception when check_violation then null;
end $$;
select pg_temp.expect('over-long personal notice refused', true);

-- Audit log carries the target.
select pg_temp.expect('admin log records the target of a personal notice',
  exists (select 1 from public.launcher_admin_actions where action = 'set_notice' and detail ->> 'target' = '00000000-0000-0000-0000-00000000000b'));
select pg_temp.expect('admin log records clearing a personal notice',
  exists (select 1 from public.launcher_admin_actions where action = 'clear_notice' and detail ->> 'target' = '00000000-0000-0000-0000-00000000000b'));

-- Deleting a user removes their personal notices (on delete cascade), not the everyone-notice.
select public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', '모두 다시');
select public.launcher_admin_set_notice('00000000-0000-0000-0000-00000000000a', '삭제될 사람에게', '00000000-0000-0000-0000-00000000000b');
delete from auth.users where id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.expect('deleting the target removes their notices only',
  (select count(*) = 0 from public.launcher_notices where target_user_id = '00000000-0000-0000-0000-00000000000b')
  and (select count(*) = 1 from public.launcher_notices where ended_at is null and target_user_id is null));

-- Only service_role may execute the functions.
select pg_temp.expect('anon and authenticated cannot execute set_notice',
  not has_function_privilege('anon', 'public.launcher_admin_set_notice(uuid,text,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.launcher_admin_set_notice(uuid,text,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.launcher_admin_set_notice(uuid,text,uuid)', 'execute'));
select pg_temp.expect('anon and authenticated cannot execute clear_notice',
  not has_function_privilege('anon', 'public.launcher_admin_clear_notice(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.launcher_admin_clear_notice(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.launcher_admin_clear_notice(uuid,uuid)', 'execute'));
select pg_temp.expect('the table is closed to anon and authenticated',
  not has_table_privilege('anon', 'public.launcher_notices', 'select')
  and not has_table_privilege('authenticated', 'public.launcher_notices', 'select')
  and has_table_privilege('service_role', 'public.launcher_notices', 'select'));
select pg_temp.expect('only the two new functions exist (no ambiguous old overloads)',
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('launcher_admin_set_notice', 'launcher_admin_clear_notice')));

select 'all private-notice checks passed' as result, count(*) as checks from check_result;
