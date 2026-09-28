-- Every server now checks players through the Bweeep Yggdrasil API, which
-- keeps characters, inventories and OP status by account UUID. A name no
-- longer carries anyone's world data, so names are only kept from being
-- mistaken for someone else's:
--   * another member's current name (last played or saved in the launcher)
--     is always taken;
--   * a name a member actually played under stays theirs for one day after
--     they move to another name; a name that was only saved and changed
--     again before playing is free right away;
--   * the owner can always go back to their own old names;
--   * a removed member's names are free one day after the removal, while
--     their account and UUID stay theirs;
--   * reserved offline UUIDs are still never handed to anyone else, but the
--     names in the reservations no longer lock anything.
-- Offline-mode servers are not allowed any more.

-- How long a name stays with the member who stopped using it.
create or replace function public.launcher_game_name_hold()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 day' $$;

-- 1. Only servers behind the Bweeep account API may be active. Inactive
-- offline releases stay as history.
alter table public.launcher_releases drop constraint if exists launcher_releases_active_needs_yggdrasil;
alter table public.launcher_releases
  add constraint launcher_releases_active_needs_yggdrasil
  check (not active or (manifest->>'gameAuth') is not distinct from 'yggdrasil');

-- 2. Name history: when a name was last played, and when it stopped being
-- the member's current name (null while it still is).
alter table public.launcher_game_name_history
  add column if not exists used_at timestamptz,
  add column if not exists released_at timestamptz;

-- Saving a name in the launcher no longer records it; playing does.
drop trigger if exists launcher_profiles_game_name_history on public.launcher_profiles;
drop function if exists public.record_launcher_game_name_history();

-- Existing data: names that were played (the current account names, and the
-- names in reservations, which came from server usercaches) count as used.
-- Their one-day hold starts now; names that were only saved are free.
insert into public.launcher_game_name_history (user_id, game_name, created_at)
select account.user_id, account.game_name, account.created_at
from public.launcher_minecraft_accounts as account
on conflict (user_id, game_name) do nothing;

insert into public.launcher_game_name_history (user_id, game_name, created_at)
select reservation.user_id, reservation.game_name, reservation.created_at
from public.launcher_minecraft_uuid_reservations as reservation
where reservation.user_id is not null and reservation.game_name ~ '^[A-Za-z0-9_]{2,16}$'
on conflict (user_id, game_name) do nothing;

update public.launcher_game_name_history as history
set
  used_at = coalesce(history.used_at, history.created_at),
  released_at = case
    when exists (
      select 1 from public.launcher_minecraft_accounts as account
      where account.user_id = history.user_id and lower(account.game_name) = lower(history.game_name)
    ) then null
    else now()
  end
where exists (
    select 1 from public.launcher_minecraft_accounts as account
    where account.user_id = history.user_id and lower(account.game_name) = lower(history.game_name)
  )
  or exists (
    select 1 from public.launcher_minecraft_uuid_reservations as reservation
    where reservation.user_id = history.user_id and lower(reservation.game_name) = lower(history.game_name)
  );

-- 3. When each removed member was removed.
create table if not exists public.launcher_removed_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  removed_at timestamptz not null default now()
);
alter table public.launcher_removed_members enable row level security;
revoke all on table public.launcher_removed_members from public, anon, authenticated;
grant select on table public.launcher_removed_members to service_role;

-- People who already left have their day start now.
insert into public.launcher_removed_members (user_id)
select distinct holder.user_id
from (
  select user_id from public.launcher_minecraft_accounts
  union select user_id from public.launcher_profiles
  union select user_id from public.launcher_game_name_history
) as holder
where not exists (select 1 from public.launcher_members as member where member.user_id = holder.user_id)
on conflict (user_id) do nothing;

create or replace function public.launcher_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.launcher_environment_access where user_id = old.user_id;
  delete from public.launcher_game_auth_tokens where user_id = old.user_id;
  delete from public.launcher_yggdrasil_joins where user_id = old.user_id;
  delete from public.launcher_game_tickets where user_id = old.user_id;
  delete from public.launcher_game_sessions where user_id = old.user_id;
  update public.launcher_invites set revoked_at = now()
  where created_by = old.user_id and revoked_at is null;
  -- The member's names are released a day from now; the account and UUID stay.
  -- A user deleted from auth has no row left to point at.
  if exists (select 1 from auth.users as auth_user where auth_user.id = old.user_id) then
    insert into public.launcher_removed_members (user_id, removed_at)
    values (old.user_id, now())
    on conflict (user_id) do update set removed_at = excluded.removed_at;
  end if;
  return old;
end;
$$;

-- An invited-back member holds their names again.
create or replace function public.launcher_member_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.launcher_removed_members where user_id = new.user_id;
  return new;
end;
$$;
drop trigger if exists launcher_members_added on public.launcher_members;
create trigger launcher_members_added
after insert on public.launcher_members
for each row
execute function public.launcher_member_added();

-- A current member, or one removed less than a day ago, still holds names.
create or replace function public.launcher_game_name_holder_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.launcher_members as member where member.user_id = p_user_id)
    or exists (
      select 1 from public.launcher_removed_members as removed
      where removed.user_id = p_user_id and removed.removed_at > now() - public.launcher_game_name_hold()
    );
$$;

-- 4. The name rule itself.
create or replace function public.launcher_game_name_available(p_user_id uuid, p_game_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (
      select 1 from public.launcher_minecraft_accounts as account
      where lower(account.game_name) = lower(p_game_name) and account.user_id <> p_user_id
        and public.launcher_game_name_holder_active(account.user_id)
    )
    and not exists (
      select 1 from public.launcher_profiles as profile
      where lower(profile.game_name) = lower(p_game_name) and profile.user_id <> p_user_id
        and public.launcher_game_name_holder_active(profile.user_id)
    )
    and not exists (
      select 1 from public.launcher_game_name_history as history
      where lower(history.game_name) = lower(p_game_name) and history.user_id <> p_user_id
        and history.used_at is not null
        and (history.released_at is null or history.released_at > now() - public.launcher_game_name_hold())
        and public.launcher_game_name_holder_active(history.user_id)
    );
$$;

-- A name that is free by the rule may still sit on a removed member's rows,
-- which the unique name indexes would trip over. Their account moves to a
-- name derived from their id (the one the launcher falls back to), and their
-- saved launcher name is dropped. Their UUID does not change.
create or replace function public.launcher_free_game_name(p_user_id uuid, p_game_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.launcher_minecraft_accounts as account
  set game_name = 'Bweep_' || substr(md5('OfflinePlayer:' || account.user_id::text), 1, 10), updated_at = now()
  where lower(account.game_name) = lower(p_game_name) and account.user_id <> p_user_id
    and not public.launcher_game_name_holder_active(account.user_id);
  delete from public.launcher_profiles as profile
  where lower(profile.game_name) = lower(p_game_name) and profile.user_id <> p_user_id
    and not public.launcher_game_name_holder_active(profile.user_id);
end;
$$;

-- The name an account leaves behind starts its one-day hold.
create or replace function public.launcher_account_name_released()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.game_name is distinct from new.game_name then
    update public.launcher_game_name_history as history
    set released_at = now()
    where history.user_id = old.user_id
      and lower(history.game_name) = lower(old.game_name)
      and history.released_at is null;
  end if;
  return new;
end;
$$;
drop trigger if exists launcher_minecraft_accounts_name_released on public.launcher_minecraft_accounts;
create trigger launcher_minecraft_accounts_name_released
after update of game_name on public.launcher_minecraft_accounts
for each row
execute function public.launcher_account_name_released();

-- 5. Launching with a name is what makes it used.
create or replace function public.launcher_claim_minecraft_account(p_user_id uuid, p_game_name text)
returns table (minecraft_uuid uuid, game_name text)
language plpgsql
security definer
set search_path = ''
as $$
-- The result columns share names with table columns used below.
#variable_conflict use_column
declare
  v_uuid uuid;
  v_current text;
begin
  -- Claims and saves for one name, and for one member, run one at a time.
  -- Locks are always taken in this order, so they cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended('launcher_game_name:' || lower(p_game_name), 0));
  perform pg_advisory_xact_lock(hashtextextended('launcher_account:' || p_user_id::text, 0));

  if not public.launcher_game_name_available(p_user_id, p_game_name) then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
  end if;
  perform public.launcher_free_game_name(p_user_id, p_game_name);

  select account.minecraft_uuid, account.game_name into v_uuid, v_current
  from public.launcher_minecraft_accounts as account
  where account.user_id = p_user_id;

  if found then
    if v_current is distinct from p_game_name then
      update public.launcher_minecraft_accounts as account
      set game_name = p_game_name, updated_at = now()
      where account.user_id = p_user_id;
    end if;
  else
    -- Reserved UUIDs hold world data on some server and are never handed to
    -- anyone but their owner; a claimed one is someone else's already.
    v_uuid := public.launcher_offline_uuid(p_game_name);
    if exists (select 1 from public.launcher_minecraft_accounts as account where account.minecraft_uuid = v_uuid)
      or exists (
        select 1 from public.launcher_minecraft_uuid_reservations as reservation
        where reservation.minecraft_uuid = v_uuid and reservation.user_id is distinct from p_user_id
      ) then
      v_uuid := gen_random_uuid();
    end if;
    insert into public.launcher_minecraft_accounts (user_id, minecraft_uuid, game_name)
    values (p_user_id, v_uuid, p_game_name);
  end if;

  insert into public.launcher_game_name_history (user_id, game_name, used_at, released_at)
  values (p_user_id, p_game_name, now(), null)
  on conflict (user_id, game_name) do update set used_at = now(), released_at = null;

  return query select v_uuid, p_game_name;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
end;
$$;

-- Saving a name in the launcher, under the same rule and locks as a claim.
create or replace function public.launcher_save_game_profile(p_user_id uuid, p_game_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('launcher_game_name:' || lower(p_game_name), 0));
  perform pg_advisory_xact_lock(hashtextextended('launcher_account:' || p_user_id::text, 0));

  if not public.launcher_game_name_available(p_user_id, p_game_name) then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
  end if;
  perform public.launcher_free_game_name(p_user_id, p_game_name);

  insert into public.launcher_profiles (user_id, game_name, updated_at)
  values (p_user_id, p_game_name, now())
  on conflict (user_id) do update set game_name = excluded.game_name, updated_at = excluded.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
end;
$$;

-- A server letting the player in confirms the name is in use.
create or replace function public.launcher_yggdrasil_has_joined(
  p_game_name text,
  p_server_id text,
  p_ip text,
  p_testers_only boolean
)
returns table (minecraft_uuid uuid, game_name text, texture_hash text, model text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid;
  v_uuid uuid;
  v_name text;
  v_hash text;
  v_model text;
begin
  select joined.user_id, account.minecraft_uuid, account.game_name, skin.texture_hash, skin.model
  into v_user_id, v_uuid, v_name, v_hash, v_model
  from public.launcher_yggdrasil_joins as joined
  join public.launcher_minecraft_accounts as account on account.user_id = joined.user_id
  join public.launcher_members as member on member.user_id = joined.user_id
  left join public.launcher_skins as skin on skin.user_id = joined.user_id
  where joined.server_id = p_server_id
    and joined.expires_at > now()
    and lower(account.game_name) = lower(p_game_name)
    and (p_ip is null or joined.ip is null or joined.ip = p_ip)
    and (
      not p_testers_only
      or member.role = 'admin'
      or exists (
        select 1 from public.launcher_environment_access as access
        where access.user_id = joined.user_id and access.environment = 'test'
      )
    )
  limit 1;
  if not found then
    return;
  end if;

  insert into public.launcher_game_name_history (user_id, game_name, used_at, released_at)
  values (v_user_id, v_name, now(), null)
  on conflict (user_id, game_name) do update set used_at = now(), released_at = null;

  return query select v_uuid, v_name, v_hash, v_model;
end;
$$;

revoke all on function public.launcher_game_name_hold() from public, anon, authenticated;
revoke all on function public.launcher_member_added() from public, anon, authenticated;
revoke all on function public.launcher_member_removed() from public, anon, authenticated;
revoke all on function public.launcher_game_name_holder_active(uuid) from public, anon, authenticated;
revoke all on function public.launcher_game_name_available(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_free_game_name(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_account_name_released() from public, anon, authenticated;
revoke all on function public.launcher_claim_minecraft_account(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_save_game_profile(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_has_joined(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.launcher_game_name_available(uuid, text) to service_role;
grant execute on function public.launcher_claim_minecraft_account(uuid, text) to service_role;
grant execute on function public.launcher_save_game_profile(uuid, text) to service_role;
grant execute on function public.launcher_yggdrasil_has_joined(text, text, text, boolean) to service_role;
