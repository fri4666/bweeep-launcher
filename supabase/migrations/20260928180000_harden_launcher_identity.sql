-- Names and Minecraft UUIDs belong to one member for good. A server keeps
-- inventories, advancements and OP status by UUID, so nobody may take over
-- another member's UUID, current name or any name they used before.

-- UUIDs that already hold world data on a server, with the member they belong
-- to. Filled from each server's usercache.json before it switches to the
-- Bweeep Yggdrasil API. A null owner means nobody may receive that UUID.
create table if not exists public.launcher_minecraft_uuid_reservations (
  minecraft_uuid uuid primary key,
  game_name text not null check (game_name ~ '^[A-Za-z0-9_]{1,16}$'),
  user_id uuid references auth.users(id) on delete set null,
  source text not null check (length(source) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists launcher_minecraft_uuid_reservations_name_idx
  on public.launcher_minecraft_uuid_reservations (lower(game_name));
alter table public.launcher_minecraft_uuid_reservations enable row level security;
revoke all on table public.launcher_minecraft_uuid_reservations from public, anon, authenticated;
grant select on table public.launcher_minecraft_uuid_reservations to service_role;

-- Launch names can be 2 characters, and account names are recorded here too.
alter table public.launcher_game_name_history drop constraint if exists launcher_game_name_history_game_name_check;
alter table public.launcher_game_name_history
  add constraint launcher_game_name_history_game_name_check check (game_name ~ '^[A-Za-z0-9_]{2,16}$');
create index if not exists launcher_game_name_history_name_idx
  on public.launcher_game_name_history (lower(game_name));

-- Two members can no longer save the same name.
create unique index if not exists launcher_profiles_game_name_key
  on public.launcher_profiles (lower(game_name));

-- A name is free for a member unless another member has it now, had it
-- before, or it is reserved for someone else (or for nobody).
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
    )
    and not exists (
      select 1 from public.launcher_profiles as profile
      where lower(profile.game_name) = lower(p_game_name) and profile.user_id <> p_user_id
    )
    and not exists (
      select 1 from public.launcher_game_name_history as history
      where lower(history.game_name) = lower(p_game_name) and history.user_id <> p_user_id
    )
    and not exists (
      select 1 from public.launcher_minecraft_uuid_reservations as reservation
      where lower(reservation.game_name) = lower(p_game_name) and reservation.user_id is distinct from p_user_id
    );
$$;

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
  -- Claims for one name, and for one member, run one at a time, so two
  -- requests cannot both pass the checks below. Locks are always taken in
  -- this order, so they cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended('launcher_game_name:' || lower(p_game_name), 0));
  perform pg_advisory_xact_lock(hashtextextended('launcher_account:' || p_user_id::text, 0));

  if not public.launcher_game_name_available(p_user_id, p_game_name) then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
  end if;

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
    -- The offline UUID keeps offline-server data only when it is certainly
    -- this member's: unclaimed and not reserved for anyone else.
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

  -- Every name a member plays under stays theirs.
  insert into public.launcher_game_name_history (user_id, game_name)
  values (p_user_id, p_game_name)
  on conflict (user_id, game_name) do nothing;

  return query select v_uuid, p_game_name;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
end;
$$;

-- Only current members pass hasJoined; a server behind /yggdrasil/testers
-- only lets in testers and admins.
drop function if exists public.launcher_yggdrasil_has_joined(text, text, text);
create or replace function public.launcher_yggdrasil_has_joined(
  p_game_name text,
  p_server_id text,
  p_ip text,
  p_testers_only boolean
)
returns table (minecraft_uuid uuid, game_name text, texture_hash text, model text)
language sql
stable
security definer
set search_path = ''
as $$
  select account.minecraft_uuid, account.game_name, skin.texture_hash, skin.model
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
$$;

-- Profiles of people who are no longer members are not served.
create or replace function public.launcher_yggdrasil_profiles(p_ids uuid[], p_names text[])
returns table (minecraft_uuid uuid, game_name text, texture_hash text, model text)
language sql
stable
security definer
set search_path = ''
as $$
  select account.minecraft_uuid, account.game_name, skin.texture_hash, skin.model
  from public.launcher_minecraft_accounts as account
  join public.launcher_members as member on member.user_id = account.user_id
  left join public.launcher_skins as skin on skin.user_id = account.user_id
  where account.minecraft_uuid = any(coalesce(p_ids, '{}'::uuid[]))
    or lower(account.game_name) in (select lower(name) from unnest(coalesce(p_names, '{}'::text[])) as name);
$$;

-- Removing a member ends their test access and every game token at once.
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
  return old;
end;
$$;
drop trigger if exists launcher_members_removed on public.launcher_members;
create trigger launcher_members_removed
after delete on public.launcher_members
for each row
execute function public.launcher_member_removed();

revoke all on function public.launcher_game_name_available(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_claim_minecraft_account(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_has_joined(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_profiles(uuid[], text[]) from public, anon, authenticated;
revoke all on function public.launcher_member_removed() from public, anon, authenticated;
grant execute on function public.launcher_game_name_available(uuid, text) to service_role;
grant execute on function public.launcher_claim_minecraft_account(uuid, text) to service_role;
grant execute on function public.launcher_yggdrasil_has_joined(text, text, text, boolean) to service_role;
grant execute on function public.launcher_yggdrasil_profiles(uuid[], text[]) to service_role;

-- Pinned search paths for the two older functions the advisor flags.
alter function public.record_launcher_game_name_history() set search_path = '';
alter function public.redeem_launcher_invite(text, uuid) set search_path = '';
