-- Game token extension, refusal records and admin functions, checked on a
-- throwaway local Supabase (migrations up to 20260930100200 applied):
--   bash scripts/local-supabase.sh start
--   docker exec -i supabase_db_bweeep-local-check psql -U postgres -v ON_ERROR_STOP=1 < scripts/verify-admin-tools.sql
--   bash scripts/local-supabase.sh stop
-- Everything runs in one transaction that is rolled back.
begin;

create function pg_temp.check(ok boolean, name text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', name; end if;
  raise notice 'passed: %', name;
end $$;

create function pg_temp.refused(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

insert into auth.users (id, aud, role, email)
select ('00000000-0000-4000-9000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'admin-tools-' || n || '@example.invalid'
from generate_series(1, 6) as n;
insert into auth.sessions (id, user_id)
select ('00000000-0000-4000-a000-00000000000' || n)::uuid, ('00000000-0000-4000-9000-00000000000' || n)::uuid
from generate_series(1, 6) as n;
insert into public.launcher_members (user_id, role)
select ('00000000-0000-4000-9000-00000000000' || n)::uuid, case when n <= 2 then 'admin' else 'member' end::public.launcher_member_role
from generate_series(1, 5) as n;

do $$
declare
  a1 uuid := '00000000-0000-4000-9000-000000000001';
  a2 uuid := '00000000-0000-4000-9000-000000000002';
  m3 uuid := '00000000-0000-4000-9000-000000000003';
  m4 uuid := '00000000-0000-4000-9000-000000000004';
  m5 uuid := '00000000-0000-4000-9000-000000000005';
  s3 uuid := '00000000-0000-4000-a000-000000000003';
  s4 uuid := '00000000-0000-4000-a000-000000000004';
  s5 uuid := '00000000-0000-4000-a000-000000000005';
  t3 text := repeat('A', 64);
  t4 text := repeat('B', 64);
  t5 text := repeat('C', 64);
  v_uuid3 uuid;
  v_expires timestamptz;
  v_reason text;
  v_release uuid;
  v_old uuid;
begin
  select minecraft_uuid into v_uuid3 from public.launcher_claim_minecraft_account(m3, 'Member3');
  perform public.launcher_claim_minecraft_account(m4, 'Member4');
  perform public.launcher_claim_minecraft_account(m5, 'Member5');

  -- 1. Extending a game token.
  insert into public.launcher_game_auth_tokens (token_hash, user_id, auth_session_id, expires_at)
  values (t3, m3, s3, now() + interval '5 minutes'),
         (t4, m4, s4, now() - interval '1 minute'),
         (t5, m5, s5, now() + interval '5 minutes');
  v_expires := public.launcher_extend_game_auth(m3, t3, 12);
  perform pg_temp.check(v_expires between now() + interval '11 hours 59 minutes' and now() + interval '12 hours 1 minute', 'a live token is extended to now + 12 hours');
  perform pg_temp.check(public.launcher_extend_game_auth(m4, t3, 12) is null, 'another member''s token cannot be extended');
  perform pg_temp.check((select expires_at from public.launcher_game_auth_tokens where token_hash = t3) = v_expires, 'a refused extension changes nothing');
  perform pg_temp.check(public.launcher_extend_game_auth(m4, t4, 12) is null, 'an expired token cannot be extended');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_extend_game_auth(%L, %L, 13)', m3, t3)) = 'INVALID_HOURS', 'more than 12 hours is refused');
  delete from auth.sessions where id = s5;
  perform pg_temp.check(public.launcher_extend_game_auth(m5, t5, 12) is null, 'a signed-out token cannot be extended');

  -- 2. Refusal records.
  perform pg_temp.check(public.launcher_record_join_failure(t4, v_uuid3, 'members') = 'token_expired', 'join: expired token');
  perform pg_temp.check(public.launcher_record_join_failure(t5, v_uuid3, 'members') = 'signed_out', 'join: signed-out session');
  perform pg_temp.check(public.launcher_record_join_failure(t3, gen_random_uuid(), 'members') = 'profile_mismatch', 'join: another profile');
  perform pg_temp.check(public.launcher_record_join_failure(repeat('D', 64), v_uuid3, 'members') = 'unknown_token', 'join: unknown token');
  perform pg_temp.check((select user_id is null from public.launcher_auth_failures where reason = 'unknown_token'), 'an unknown token names nobody');
  delete from public.launcher_game_auth_tokens where token_hash = t3;
  perform pg_temp.check(public.launcher_record_join_failure(t3, v_uuid3, 'members') = 'token_revoked', 'join: a retired token is told apart from an unknown one');
  perform pg_temp.check((select user_id from public.launcher_auth_failures where reason = 'token_revoked') = m3, 'a retired token names its owner');
  perform pg_temp.check(not exists (select 1 from public.launcher_game_auth_retired where token_hash = t4), 'an already expired token leaves no retired row');

  insert into public.launcher_yggdrasil_joins (server_id, user_id, ip, expires_at) values ('srv-a', m4, null, now() + interval '30 seconds');
  perform pg_temp.check(public.launcher_record_has_joined_failure('Someone', 'srv-a', false) = 'name_mismatch', 'hasJoined: a name other than the joined account');
  perform pg_temp.check(public.launcher_record_has_joined_failure('Member4', 'srv-a', true) = 'testers_only', 'hasJoined: not a tester on a testers-only server');
  perform pg_temp.check((select audience from public.launcher_auth_failures where reason = 'testers_only') = 'testers', 'the testers route is recorded');
  perform pg_temp.check(public.launcher_record_has_joined_failure('Member4', 'srv-none', false) = 'no_join', 'hasJoined: nobody joined');
  perform public.launcher_record_has_joined_failure('Member4', 'srv-none', false);
  perform pg_temp.check((select count(*) from public.launcher_auth_failures where reason = 'no_join') = 1, 'anonymous repeats within a minute are recorded once');
  insert into public.launcher_auth_failures (user_id, game_name, audience, reason, created_at) values (m3, 'Old', 'members', 'unknown', now() - interval '8 days');
  perform public.launcher_record_has_joined_failure('Member4', 'srv-a', true);
  perform pg_temp.check(not exists (select 1 from public.launcher_auth_failures where game_name = 'Old'), 'rows older than seven days are removed');

  -- 3. Diagnostics rate limit.
  perform public.launcher_begin_diagnostics(m3, 1000);
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_begin_diagnostics(%L, 1000)', m3)) = 'DIAGNOSTICS_RATE_LIMITED', 'one upload per ten minutes');
  update public.launcher_diagnostics set created_at = now() - interval '8 days' where user_id = m3;
  select id into v_old from public.launcher_diagnostics where user_id = m3;
  perform pg_temp.check((select v_old = any(expired_ids) from public.launcher_begin_diagnostics(m3, 1000)), 'an upload after the wait works and hands back expired files');
  perform pg_temp.check(not exists (select 1 from public.launcher_diagnostics where id = v_old), 'the expired row is gone');

  -- 4. Admin checks.
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_set_role(%L, %L, %L)', m3, m4, 'admin')) = 'NOT_ADMIN', 'a member cannot change roles');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_remove_member(%L, %L)', m3, m4)) = 'NOT_ADMIN', 'a member cannot remove members');
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_admin_name_holds(%L)', m3)) = 'NOT_ADMIN', 'a member cannot list name holds');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_set_role(%L, %L, %L)', a1, a1, 'member')) = 'CANNOT_CHANGE_SELF', 'an admin cannot demote themselves');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_remove_member(%L, %L)', a1, a1)) = 'CANNOT_CHANGE_SELF', 'an admin cannot remove themselves');
  perform public.launcher_admin_set_role(a1, a2, 'member');
  perform pg_temp.check((select role from public.launcher_members where user_id = a2) = 'member', 'an admin demotes another admin');
  perform pg_temp.check((select detail->>'from' = 'admin' and detail->>'to' = 'member' and actor_id = a1 from public.launcher_admin_actions where action = 'set_role'), 'the role change is recorded');
  -- a1 is now the only admin: a demoted a2 cannot act, and nobody can take a1 away.
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_remove_member(%L, %L)', a2, a1)) = 'NOT_ADMIN', 'a demoted admin loses admin actions at once');
  update public.launcher_members set role = 'admin' where user_id = a2;
  perform public.launcher_admin_set_role(a2, a1, 'member');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_set_role(%L, %L, %L)', a2, a2, 'member')) = 'CANNOT_CHANGE_SELF', 'the last admin is also self');
  update public.launcher_members set role = 'admin' where user_id = a1;
  perform public.launcher_admin_set_role(a1, m4, 'admin');
  perform public.launcher_admin_set_role(a1, m4, 'member');

  perform public.launcher_admin_set_tester(a1, m4, true);
  perform pg_temp.check(exists (select 1 from public.launcher_environment_access where user_id = m4), 'the admin makes a tester');
  perform public.launcher_admin_set_tester(a1, m4, true);
  perform pg_temp.check((select count(*) from public.launcher_admin_actions where action = 'set_tester') = 1, 'setting a tester twice is recorded once');

  insert into public.launcher_game_auth_tokens (token_hash, user_id, auth_session_id, expires_at) values (repeat('E', 64), m4, s4, now() + interval '1 hour');
  perform public.launcher_admin_remove_member(a1, m4);
  perform pg_temp.check(not exists (select 1 from public.launcher_members where user_id = m4), 'the member is removed');
  perform pg_temp.check(not exists (select 1 from public.launcher_game_auth_tokens where user_id = m4), 'the removed member''s tokens are gone');
  perform pg_temp.check(not exists (select 1 from public.launcher_environment_access where user_id = m4), 'the removed member''s test access is gone');
  perform pg_temp.check(exists (select 1 from public.launcher_removed_members where user_id = m4), 'the removal starts the name hold');
  perform pg_temp.check(public.launcher_record_join_failure(repeat('E', 64), v_uuid3, 'members') = 'not_member', 'join: a removed member''s token says not a member');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_remove_member(%L, %L)', a1, m4)) = 'MEMBER_NOT_FOUND', 'removing twice is refused');

  -- 5. Name holds.
  perform public.launcher_save_game_profile(m3, 'Member3b');
  perform public.launcher_claim_minecraft_account(m3, 'Member3b');
  perform pg_temp.check(exists (select 1 from public.launcher_admin_name_holds(a1) where game_name = 'Member3' and kind = 'released'), 'a name a member moved away from is listed');
  perform pg_temp.check(exists (select 1 from public.launcher_admin_name_holds(a1) where game_name = 'Member4' and kind = 'removed'), 'a removed member''s name is listed');
  perform pg_temp.check(not exists (select 1 from public.launcher_admin_name_holds(a1) where game_name = 'Member3b'), 'a current name is not a hold');
  perform pg_temp.check(not public.launcher_game_name_available(m5, 'Member3'), 'the moved-away name is held for others');
  perform pg_temp.check(public.launcher_admin_release_name(a1, m3, 'Member3') = 'released', 'the admin releases a held name');
  perform pg_temp.check(public.launcher_game_name_available(m5, 'Member3'), 'the released name is free');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_release_name(%L, %L, %L)', a1, m3, 'Member3b')) = 'NAME_NOT_HELD', 'a current name cannot be released');
  perform pg_temp.check(not public.launcher_game_name_available(m5, 'Member4'), 'the removed member''s name is held');
  perform pg_temp.check(public.launcher_admin_release_name(a1, m4, 'Member4') = 'removed', 'the admin frees a removed member''s names');
  perform pg_temp.check(public.launcher_game_name_available(m5, 'Member4'), 'the removed member''s name is free');

  -- 6. Reservations.
  insert into public.launcher_minecraft_uuid_reservations (minecraft_uuid, game_name, user_id, source)
  values (public.launcher_offline_uuid('Resv'), 'Resv', m5, 'test');
  perform pg_temp.check((select count(*) from public.launcher_admin_reservations(a1) where game_name = 'Resv') = 1, 'reservations are listed');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_admin_delete_reservation(%L, %L)', m5, public.launcher_offline_uuid('Resv'))) = 'NOT_ADMIN', 'a member cannot delete a reservation');
  perform public.launcher_admin_delete_reservation(a1, public.launcher_offline_uuid('Resv'));
  perform pg_temp.check(not exists (select 1 from public.launcher_minecraft_uuid_reservations where game_name = 'Resv'), 'the reservation is deleted');
  perform pg_temp.check((select detail->>'gameName' from public.launcher_admin_actions where action = 'delete_reservation') = 'Resv', 'the deletion is recorded with the name');

  -- 7. Releases.
  insert into public.launcher_releases (pack_id, version, manifest, active, created_by) values
    ('admin-pack', '1', '{"id":"admin-pack","gameAuth":"yggdrasil"}', true, a1),
    ('admin-pack', '2', '{"id":"admin-pack","gameAuth":"yggdrasil"}', false, a1),
    ('admin-pack', '0', '{"id":"admin-pack","gameAuth":"offline"}', false, a1),
    ('admin-pack', 'x', '{"id":"other-pack","gameAuth":"yggdrasil"}', false, a1);
  select id into v_release from public.launcher_releases where pack_id = 'admin-pack' and version = '2';
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_admin_activate_release(%L, %L)', m5, v_release)) = 'NOT_ADMIN', 'a member cannot switch releases');
  perform pg_temp.check((select previous_version = '1' from public.launcher_admin_activate_release(a1, v_release)), 'the admin activates version 2');
  perform pg_temp.check((select array_agg(version) from public.launcher_releases where pack_id = 'admin-pack' and active) = array['2'], 'only version 2 is active');
  select id into v_release from public.launcher_releases where pack_id = 'admin-pack' and version = '1';
  perform public.launcher_admin_activate_release(a1, v_release);
  perform pg_temp.check((select array_agg(version) from public.launcher_releases where pack_id = 'admin-pack' and active) = array['1'], 'rolling back to version 1 switches 2 off');
  select id into v_release from public.launcher_releases where pack_id = 'admin-pack' and version = '0';
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_admin_activate_release(%L, %L)', a1, v_release)) = 'OFFLINE_RELEASE', 'an offline release cannot be activated');
  select id into v_release from public.launcher_releases where pack_id = 'admin-pack' and version = 'x';
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_admin_activate_release(%L, %L)', a1, v_release)) = 'PACK_MISMATCH', 'a manifest for another pack cannot be activated');
  perform pg_temp.check((select array_agg(version) from public.launcher_releases where pack_id = 'admin-pack' and active) = array['1'], 'refused activations leave the active release alone');
  perform pg_temp.check((select count(*) from public.launcher_admin_actions where action = 'activate_release') = 2, 'each switch is recorded');
end $$;

-- The tables stay closed to the public API roles.
do $$
begin
  perform pg_temp.check(not has_table_privilege('anon', 'public.launcher_auth_failures', 'select'), 'anon cannot read refusals');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.launcher_admin_actions', 'select'), 'authenticated cannot read the admin log');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.launcher_diagnostics', 'select'), 'authenticated cannot read diagnostics');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.launcher_admin_set_role(uuid, uuid, public.launcher_member_role)', 'execute'), 'authenticated cannot call admin functions');
  perform pg_temp.check(not has_function_privilege('anon', 'public.launcher_extend_game_auth(uuid, text, integer)', 'execute'), 'anon cannot extend tokens');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.launcher_auth_failures'::regclass), 'refusals have RLS on');
  perform pg_temp.check((select not public from storage.buckets where id = 'launcher-diagnostics'), 'the diagnostics bucket is private');
end $$;

rollback;
