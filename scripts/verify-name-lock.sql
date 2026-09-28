-- Name rule and offline-server ban, checked on a throwaway local Supabase:
--   bash scripts/local-supabase.sh start
--   docker cp supabase/migrations/20260929120000_relax_name_lock.sql supabase_db_bweeep-local-check:/tmp/relax_name_lock.sql
--   docker exec -i supabase_db_bweeep-local-check psql -U postgres -v ON_ERROR_STOP=1 < scripts/verify-name-lock.sql
--   bash scripts/local-supabase.sh stop
-- Everything runs in one transaction that is rolled back. Time is simulated
-- by moving timestamps back a day.
begin;

create function pg_temp.check(ok boolean, name text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', name; end if;
  raise notice 'passed: %', name;
end $$;

create function pg_temp.taken(p_user uuid, p_name text) returns boolean language plpgsql as $$
begin
  return not public.launcher_game_name_available(p_user, p_name);
end $$;

create function pg_temp.refused(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

create function pg_temp.day_later(p_user uuid, p_name text) returns void language sql as $$
  update public.launcher_game_name_history
  set released_at = released_at - interval '25 hours', used_at = used_at - interval '25 hours'
  where user_id = p_user and lower(game_name) = lower(p_name);
$$;

insert into auth.users (id, aud, role, email)
select ('00000000-0000-4000-8000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'name-lock-' || n || '@example.invalid'
from generate_series(1, 6) as n;
insert into public.launcher_members (user_id)
select ('00000000-0000-4000-8000-00000000000' || n)::uuid from generate_series(1, 5) as n;

do $$
declare
  u1 uuid := '00000000-0000-4000-8000-000000000001';
  u2 uuid := '00000000-0000-4000-8000-000000000002';
  u3 uuid := '00000000-0000-4000-8000-000000000003';
  u4 uuid := '00000000-0000-4000-8000-000000000004';
  u5 uuid := '00000000-0000-4000-8000-000000000005';
  u6 uuid := '00000000-0000-4000-8000-000000000006';
  v_uuid uuid;
  v_error text;
begin
  -- A name only saved and changed before playing is free right away.
  perform public.launcher_save_game_profile(u1, 'Alpha');
  perform pg_temp.check(pg_temp.taken(u2, 'alpha'), 'a saved name is taken for others');
  perform pg_temp.check(pg_temp.refused(format('select public.launcher_save_game_profile(%L, %L)', u2, 'ALPHA')) = 'GAME_NAME_TAKEN', 'saving another member''s saved name is refused');
  perform public.launcher_save_game_profile(u1, 'Beta');
  perform pg_temp.check(not pg_temp.taken(u2, 'Alpha'), 'a saved-then-changed name is free at once');
  perform pg_temp.check((select count(*) from public.launcher_game_name_history where user_id = u1) = 0, 'saving records no history');

  -- A played name stays the player's for a day after they move on.
  select minecraft_uuid into v_uuid from public.launcher_claim_minecraft_account(u1, 'Beta');
  perform pg_temp.check((select used_at is not null and released_at is null from public.launcher_game_name_history where user_id = u1 and game_name = 'Beta'), 'launching marks the name used');
  perform public.launcher_save_game_profile(u1, 'Gamma');
  perform pg_temp.check(pg_temp.taken(u2, 'Beta'), 'the name still on the account is taken');
  perform public.launcher_claim_minecraft_account(u1, 'Gamma');
  perform pg_temp.check((select minecraft_uuid from public.launcher_minecraft_accounts where user_id = u1) = v_uuid, 'renaming keeps the UUID');
  perform pg_temp.check((select released_at is not null from public.launcher_game_name_history where user_id = u1 and game_name = 'Beta'), 'the old name starts its hold');
  perform pg_temp.check(pg_temp.taken(u2, 'beta'), 'a played name is held for others within a day');
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_claim_minecraft_account(%L, %L)', u2, 'Beta')) = 'GAME_NAME_TAKEN', 'claiming a held name is refused');
  perform pg_temp.check(not pg_temp.taken(u1, 'Beta'), 'the owner may go back to their old name');
  perform pg_temp.day_later(u1, 'Beta');
  perform pg_temp.check(not pg_temp.taken(u2, 'Beta'), 'a played name is free after a day');
  perform public.launcher_save_game_profile(u2, 'Beta');
  perform public.launcher_claim_minecraft_account(u2, 'Beta');
  perform pg_temp.check(pg_temp.taken(u1, 'Beta'), 'once another member plays it, it is theirs');

  -- The owner returns to an old name within the day.
  perform public.launcher_save_game_profile(u1, 'Delta');
  perform public.launcher_claim_minecraft_account(u1, 'Delta');
  perform pg_temp.check(pg_temp.taken(u3, 'Gamma'), 'Gamma is held for others');
  perform public.launcher_save_game_profile(u1, 'Gamma');
  perform public.launcher_claim_minecraft_account(u1, 'Gamma');
  perform pg_temp.check((select game_name from public.launcher_minecraft_accounts where user_id = u1) = 'Gamma', 'the owner got the old name back');
  perform pg_temp.check((select released_at is null from public.launcher_game_name_history where user_id = u1 and game_name = 'Gamma'), 'the returned name is current again');
  perform pg_temp.check(pg_temp.taken(u3, 'Delta'), 'the name just left is held');

  -- Reservations keep UUIDs, not names.
  insert into public.launcher_minecraft_uuid_reservations (minecraft_uuid, game_name, user_id, source)
  values (public.launcher_offline_uuid('Resv'), 'Resv', u5, 'test'),
         (public.launcher_offline_uuid('Nobody'), 'Nobody', null, 'test');
  perform pg_temp.check(not pg_temp.taken(u4, 'Resv') and not pg_temp.taken(u4, 'Nobody'), 'reserved names are not locked');
  select minecraft_uuid into v_uuid from public.launcher_claim_minecraft_account(u4, 'Resv');
  perform pg_temp.check(v_uuid <> public.launcher_offline_uuid('Resv'), 'a UUID reserved for someone else is never handed out');
  perform public.launcher_claim_minecraft_account(u3, 'Nobody');
  perform pg_temp.check((select minecraft_uuid from public.launcher_minecraft_accounts where user_id = u3) <> public.launcher_offline_uuid('Nobody'), 'a UUID reserved for nobody is never handed out');
  perform pg_temp.check(pg_temp.refused(format('select * from public.launcher_claim_minecraft_account(%L, %L)', u5, 'Resv')) = 'GAME_NAME_TAKEN', 'the reservation owner cannot take a name in use');

  -- A removed member's names free up a day after removal; the UUID stays theirs.
  perform public.launcher_save_game_profile(u5, 'Epsilon');
  select minecraft_uuid into v_uuid from public.launcher_claim_minecraft_account(u5, 'Epsilon');
  delete from public.launcher_members where user_id = u5;
  perform pg_temp.check(exists (select 1 from public.launcher_removed_members where user_id = u5), 'the removal time is recorded');
  perform pg_temp.check(pg_temp.taken(u4, 'Epsilon'), 'a removed member''s name is held for a day');
  update public.launcher_removed_members set removed_at = removed_at - interval '25 hours' where user_id = u5;
  perform pg_temp.check(not pg_temp.taken(u4, 'Epsilon'), 'a removed member''s name is free after a day');
  perform public.launcher_save_game_profile(u4, 'Epsilon');
  perform public.launcher_claim_minecraft_account(u4, 'Epsilon');
  perform pg_temp.check((select game_name from public.launcher_minecraft_accounts where user_id = u4) = 'Epsilon', 'another member took the freed name');
  perform pg_temp.check((select minecraft_uuid from public.launcher_minecraft_accounts where user_id = u5) = v_uuid, 'the removed member keeps their UUID');
  perform pg_temp.check((select game_name from public.launcher_minecraft_accounts where user_id = u5) ~ '^Bweep_[0-9a-f]{10}$', 'the removed member''s account moved to its fallback name');
  perform pg_temp.check(not exists (select 1 from public.launcher_profiles where user_id = u5), 'the removed member''s saved name is dropped');
  insert into public.launcher_members (user_id) values (u5);
  perform pg_temp.check(not exists (select 1 from public.launcher_removed_members where user_id = u5), 'an invited-back member holds names again');

  -- hasJoined confirms the name in use.
  update public.launcher_game_name_history set used_at = now() - interval '2 hours' where user_id = u1 and game_name = 'Gamma';
  insert into public.launcher_yggdrasil_joins (server_id, user_id, ip, expires_at) values ('srv-1', u1, null, now() + interval '30 seconds');
  perform pg_temp.check((select count(*) from public.launcher_yggdrasil_has_joined('gamma', 'srv-1', null, false)) = 1, 'hasJoined still answers');
  perform pg_temp.check((select used_at > now() - interval '1 minute' from public.launcher_game_name_history where user_id = u1 and game_name = 'Gamma'), 'hasJoined refreshes the use time');

  -- Offline servers cannot be active.
  v_error := pg_temp.refused(format(
    'insert into public.launcher_releases (pack_id, version, manifest, active, created_by) values (%L, %L, %L::jsonb, true, %L)',
    'offline-pack', '1', '{"gameAuth":"offline"}', u1));
  perform pg_temp.check(v_error like '%launcher_releases_active_needs_yggdrasil%', 'an active offline release is rejected');
  v_error := pg_temp.refused(format(
    'insert into public.launcher_releases (pack_id, version, manifest, active, created_by) values (%L, %L, %L::jsonb, true, %L)',
    'legacy-pack', '1', '{}', u1));
  perform pg_temp.check(v_error like '%launcher_releases_active_needs_yggdrasil%', 'an active release without gameAuth is rejected');
  insert into public.launcher_releases (pack_id, version, manifest, active, created_by) values ('offline-pack', '0', '{"gameAuth":"offline"}', false, u1);
  insert into public.launcher_releases (pack_id, version, manifest, active, created_by) values ('online-pack', '1', '{"gameAuth":"yggdrasil"}', true, u1);
  v_error := pg_temp.refused('update public.launcher_releases set active = true where pack_id = ''offline-pack''');
  perform pg_temp.check(v_error like '%launcher_releases_active_needs_yggdrasil%', 'an offline release cannot be switched on');
  perform pg_temp.check(true, 'inactive offline and active yggdrasil releases are accepted');

  -- Rows from before this migration: only names with evidence of play are kept, for a day from now.
  insert into public.launcher_game_name_history (user_id, game_name, created_at) values
    (u6, 'OldSaved', now() - interval '5 days'),
    (u3, 'OldPlayed', now() - interval '5 days');
  insert into public.launcher_minecraft_uuid_reservations (minecraft_uuid, game_name, user_id, source)
  values (public.launcher_offline_uuid('OldPlayed'), 'OldPlayed', u3, 'test');
end $$;

-- Re-running the migration's backfill must be safe and must treat the rows above as pre-migration data.
\i /tmp/relax_name_lock.sql

do $$
declare
  u3 uuid := '00000000-0000-4000-8000-000000000003';
  u4 uuid := '00000000-0000-4000-8000-000000000004';
  u6 uuid := '00000000-0000-4000-8000-000000000006';
begin
  perform pg_temp.check(not pg_temp.taken(u4, 'OldSaved'), 'backfill: an old saved-only name is free');
  perform pg_temp.check(pg_temp.taken(u4, 'OldPlayed'), 'backfill: an old played (reserved) name is held for a day');
  perform pg_temp.check((select released_at > now() - interval '1 minute' from public.launcher_game_name_history where user_id = u3 and game_name = 'OldPlayed'), 'backfill: the hold starts at deploy');
  perform pg_temp.check((select released_at is null from public.launcher_game_name_history where user_id = u3 and game_name = 'Nobody'), 'backfill: the current account name stays current');
  perform pg_temp.check(exists (select 1 from public.launcher_removed_members where user_id = u6), 'backfill: people with names who are not members get a removal time');
end $$;

rollback;
