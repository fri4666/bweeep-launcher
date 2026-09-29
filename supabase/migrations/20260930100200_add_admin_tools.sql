-- The launcher's admin tab. launcher-access checks that the caller is an
-- admin before any of these run, and every function checks it again. Each
-- change is recorded in launcher_admin_actions in the same transaction.

create table if not exists public.launcher_admin_actions (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action ~ '^[a-z][a-z_]{1,40}$'),
  target text check (target is null or length(target) <= 200),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists launcher_admin_actions_created_at_idx on public.launcher_admin_actions (created_at desc);
alter table public.launcher_admin_actions enable row level security;
revoke all on table public.launcher_admin_actions from public, anon, authenticated;
grant select, insert on table public.launcher_admin_actions to service_role;

create or replace function public.launcher_require_admin(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.launcher_members as member
    where member.user_id = p_actor and member.role = 'admin'
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_ADMIN';
  end if;
end;
$$;

create or replace function public.launcher_log_admin_action(p_actor uuid, p_action text, p_target text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.launcher_admin_actions (actor_id, action, target, detail)
  values (p_actor, p_action, p_target, coalesce(p_detail, '{}'::jsonb));
$$;

-- Role changes and removals run one at a time, so two admins cannot demote
-- each other at once and leave nobody in charge.
create or replace function public.launcher_admin_set_role(
  p_actor uuid,
  p_user_id uuid,
  p_role public.launcher_member_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.launcher_member_role;
begin
  perform pg_advisory_xact_lock(hashtextextended('launcher_admin_roles', 0));
  perform public.launcher_require_admin(p_actor);
  select member.role into v_old from public.launcher_members as member where member.user_id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  if v_old = p_role then
    return;
  end if;
  if p_user_id = p_actor then
    raise exception using errcode = 'P0001', message = 'CANNOT_CHANGE_SELF';
  end if;
  if v_old = 'admin' and (select count(*) from public.launcher_members where role = 'admin') <= 1 then
    raise exception using errcode = 'P0001', message = 'LAST_ADMIN';
  end if;
  update public.launcher_members set role = p_role where user_id = p_user_id;
  perform public.launcher_log_admin_action(p_actor, 'set_role', p_user_id::text, jsonb_build_object('from', v_old, 'to', p_role));
end;
$$;

-- Removing a member deletes their launcher_members row; the removal trigger
-- then ends their tokens, joins, tickets, invites and test access and starts
-- the one-day hold on their names, as for any other removal.
create or replace function public.launcher_admin_remove_member(p_actor uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.launcher_member_role;
begin
  perform pg_advisory_xact_lock(hashtextextended('launcher_admin_roles', 0));
  perform public.launcher_require_admin(p_actor);
  if p_user_id = p_actor then
    raise exception using errcode = 'P0001', message = 'CANNOT_CHANGE_SELF';
  end if;
  select member.role into v_role from public.launcher_members as member where member.user_id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  if v_role = 'admin' and (select count(*) from public.launcher_members where role = 'admin') <= 1 then
    raise exception using errcode = 'P0001', message = 'LAST_ADMIN';
  end if;
  delete from public.launcher_members where user_id = p_user_id;
  perform public.launcher_log_admin_action(p_actor, 'remove_member', p_user_id::text, jsonb_build_object('role', v_role));
end;
$$;

create or replace function public.launcher_admin_set_tester(p_actor uuid, p_user_id uuid, p_tester boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.launcher_require_admin(p_actor);
  if not exists (select 1 from public.launcher_members where user_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  if p_tester then
    insert into public.launcher_environment_access (user_id, environment, granted_by)
    values (p_user_id, 'test', p_actor)
    on conflict (user_id, environment) do nothing;
  else
    delete from public.launcher_environment_access where user_id = p_user_id and environment = 'test';
  end if;
  if found then
    perform public.launcher_log_admin_action(p_actor, 'set_tester', p_user_id::text, jsonb_build_object('tester', p_tester));
  end if;
end;
$$;

-- Names held for a day: names current members moved away from, and every
-- name of a member removed less than a day ago.
create or replace function public.launcher_admin_name_holds(p_actor uuid)
returns table (user_id uuid, game_name text, kind text, held_until timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.launcher_require_admin(p_actor);
  return query
  select history.user_id, history.game_name, 'released'::text, history.released_at + public.launcher_game_name_hold()
  from public.launcher_game_name_history as history
  join public.launcher_members as member on member.user_id = history.user_id
  where history.used_at is not null
    and history.released_at is not null
    and history.released_at > now() - public.launcher_game_name_hold()
  union all
  select removed.user_id, held.game_name, 'removed'::text, removed.removed_at + public.launcher_game_name_hold()
  from public.launcher_removed_members as removed
  cross join lateral (
    select account.game_name from public.launcher_minecraft_accounts as account where account.user_id = removed.user_id
    union
    select profile.game_name from public.launcher_profiles as profile where profile.user_id = removed.user_id
    union
    select history.game_name from public.launcher_game_name_history as history
    where history.user_id = removed.user_id and history.used_at is not null
      and (history.released_at is null or history.released_at > now() - public.launcher_game_name_hold())
  ) as held
  where removed.removed_at > now() - public.launcher_game_name_hold()
  order by 4, 2;
end;
$$;

-- Ends a hold now. For a removed member that frees all of their names.
create or replace function public.launcher_admin_release_name(p_actor uuid, p_user_id uuid, p_game_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  perform public.launcher_require_admin(p_actor);
  -- The same lock as claims and saves of this name.
  perform pg_advisory_xact_lock(hashtextextended('launcher_game_name:' || lower(p_game_name), 0));
  update public.launcher_removed_members as removed
  set removed_at = now() - public.launcher_game_name_hold() - interval '1 second'
  where removed.user_id = p_user_id and removed.removed_at > now() - public.launcher_game_name_hold();
  if found then
    v_kind := 'removed';
  else
    update public.launcher_game_name_history as history
    set released_at = now() - public.launcher_game_name_hold() - interval '1 second'
    where history.user_id = p_user_id and lower(history.game_name) = lower(p_game_name)
      and history.used_at is not null and history.released_at is not null
      and history.released_at > now() - public.launcher_game_name_hold();
    if not found then
      raise exception using errcode = 'P0001', message = 'NAME_NOT_HELD';
    end if;
    v_kind := 'released';
  end if;
  perform public.launcher_log_admin_action(p_actor, 'release_name', p_user_id::text, jsonb_build_object('gameName', p_game_name, 'kind', v_kind));
  return v_kind;
end;
$$;

create or replace function public.launcher_admin_reservations(p_actor uuid)
returns table (minecraft_uuid uuid, game_name text, user_id uuid, source text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.launcher_require_admin(p_actor);
  return query
  select reservation.minecraft_uuid, reservation.game_name, reservation.user_id, reservation.source, reservation.created_at
  from public.launcher_minecraft_uuid_reservations as reservation
  order by reservation.game_name;
end;
$$;

-- Without the reservation the UUID can go to whoever next claims a name that
-- maps to it, together with the world data stored under it.
create or replace function public.launcher_admin_delete_reservation(p_actor uuid, p_minecraft_uuid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.launcher_minecraft_uuid_reservations%rowtype;
begin
  perform public.launcher_require_admin(p_actor);
  delete from public.launcher_minecraft_uuid_reservations as reservation
  where reservation.minecraft_uuid = p_minecraft_uuid
  returning * into v_row;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;
  perform public.launcher_log_admin_action(p_actor, 'delete_reservation', p_minecraft_uuid::text, jsonb_build_object(
    'gameName', v_row.game_name, 'userId', v_row.user_id, 'source', v_row.source
  ));
end;
$$;

-- Makes one stored release the pack's active one and switches the previous
-- one off in the same transaction. The table constraint still refuses an
-- active release that does not use the Bweeep account API.
create or replace function public.launcher_admin_activate_release(p_actor uuid, p_release_id uuid)
returns table (pack_id text, version text, previous_version text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pack text;
  v_version text;
  v_active boolean;
  v_manifest jsonb;
  v_previous text;
begin
  perform public.launcher_require_admin(p_actor);
  select release.pack_id into v_pack from public.launcher_releases as release where release.id = p_release_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'RELEASE_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('launcher_release:' || v_pack, 0));
  perform 1 from public.launcher_releases as release where release.pack_id = v_pack for update;
  select release.version, release.active, release.manifest into v_version, v_active, v_manifest
  from public.launcher_releases as release where release.id = p_release_id;
  if (v_manifest->>'gameAuth') is distinct from 'yggdrasil' then
    raise exception using errcode = 'P0001', message = 'OFFLINE_RELEASE';
  end if;
  if (v_manifest->>'id') is distinct from v_pack then
    raise exception using errcode = 'P0001', message = 'PACK_MISMATCH';
  end if;
  select release.version into v_previous from public.launcher_releases as release where release.pack_id = v_pack and release.active;
  if not v_active then
    update public.launcher_releases as release set active = false where release.pack_id = v_pack and release.active;
    update public.launcher_releases as release set active = true where release.id = p_release_id;
    perform public.launcher_log_admin_action(p_actor, 'activate_release', v_pack, jsonb_build_object('version', v_version, 'previous', v_previous));
  end if;
  return query select v_pack, v_version, v_previous;
end;
$$;

revoke all on function public.launcher_require_admin(uuid) from public, anon, authenticated;
revoke all on function public.launcher_log_admin_action(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.launcher_admin_set_role(uuid, uuid, public.launcher_member_role) from public, anon, authenticated;
revoke all on function public.launcher_admin_remove_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.launcher_admin_set_tester(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.launcher_admin_name_holds(uuid) from public, anon, authenticated;
revoke all on function public.launcher_admin_release_name(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_admin_reservations(uuid) from public, anon, authenticated;
revoke all on function public.launcher_admin_delete_reservation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.launcher_admin_activate_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.launcher_log_admin_action(uuid, text, text, jsonb) to service_role;
grant execute on function public.launcher_admin_set_role(uuid, uuid, public.launcher_member_role) to service_role;
grant execute on function public.launcher_admin_remove_member(uuid, uuid) to service_role;
grant execute on function public.launcher_admin_set_tester(uuid, uuid, boolean) to service_role;
grant execute on function public.launcher_admin_name_holds(uuid) to service_role;
grant execute on function public.launcher_admin_release_name(uuid, uuid, text) to service_role;
grant execute on function public.launcher_admin_reservations(uuid) to service_role;
grant execute on function public.launcher_admin_delete_reservation(uuid, uuid) to service_role;
grant execute on function public.launcher_admin_activate_release(uuid, uuid) to service_role;
