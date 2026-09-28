-- Bweeep runs its own Yggdrasil API (the `yggdrasil` Edge Function) for
-- authlib-injector. Servers of any Minecraft version or loader then verify
-- launcher players and receive their skins without a server-side mod.

-- Same bytes as Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name), which
-- offline-mode servers use. Accounts start from this UUID so players keep the
-- world data they already have on an offline server.
create or replace function public.launcher_offline_uuid(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select (
    substr(h, 1, 12) || '3' || substr(h, 14, 3)
    || substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int & 3) + 1, 1)
    || substr(h, 18)
  )::uuid
  from (select md5('OfflinePlayer:' || p_name) as h) as digest;
$$;

-- One Minecraft identity per launcher account. The UUID never changes after
-- it is assigned, so renaming keeps inventories, advancements and OP status.
create table if not exists public.launcher_minecraft_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  minecraft_uuid uuid not null unique,
  game_name text not null check (game_name ~ '^[A-Za-z0-9_]{2,16}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists launcher_minecraft_accounts_game_name_key
  on public.launcher_minecraft_accounts (lower(game_name));

-- Tokens the launcher hands to Minecraft as its access token. Only hashes are stored.
create table if not exists public.launcher_game_auth_tokens (
  token_hash text primary key check (token_hash ~ '^[A-F0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists launcher_game_auth_tokens_expires_at_idx
  on public.launcher_game_auth_tokens (expires_at);
create index if not exists launcher_game_auth_tokens_user_id_idx
  on public.launcher_game_auth_tokens (user_id);

-- A client announces a join; the server then asks whether it happened.
create table if not exists public.launcher_yggdrasil_joins (
  server_id text not null check (length(server_id) between 1 and 128),
  user_id uuid not null references auth.users(id) on delete cascade,
  ip text,
  expires_at timestamptz not null,
  primary key (server_id, user_id)
);

create table if not exists public.launcher_skins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  texture_hash text not null check (texture_hash ~ '^[a-f0-9]{64}$'),
  model text not null check (model in ('default', 'slim')),
  updated_at timestamptz not null default now()
);

-- The texture signing key is created by the function on first use, so no
-- secret has to live in the repository or in deploy settings.
create table if not exists public.launcher_yggdrasil_keys (
  id smallint primary key default 1 check (id = 1),
  private_key text not null,
  public_key text not null,
  created_at timestamptz not null default now()
);

alter table public.launcher_minecraft_accounts enable row level security;
alter table public.launcher_game_auth_tokens enable row level security;
alter table public.launcher_yggdrasil_joins enable row level security;
alter table public.launcher_skins enable row level security;
alter table public.launcher_yggdrasil_keys enable row level security;
revoke all on table
  public.launcher_minecraft_accounts,
  public.launcher_game_auth_tokens,
  public.launcher_yggdrasil_joins,
  public.launcher_skins,
  public.launcher_yggdrasil_keys
  from public, anon, authenticated;
grant select on table public.launcher_minecraft_accounts to service_role;
grant select, insert, delete on table public.launcher_game_auth_tokens to service_role;
grant select, insert, update, delete on table public.launcher_skins to service_role;
grant select, insert on table public.launcher_yggdrasil_keys to service_role;

-- Creates the account's Minecraft identity on first use and keeps its name current.
create or replace function public.launcher_claim_minecraft_account(p_user_id uuid, p_game_name text)
returns table (minecraft_uuid uuid, game_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid uuid;
begin
  if exists (
    select 1 from public.launcher_minecraft_accounts as account
    where lower(account.game_name) = lower(p_game_name) and account.user_id <> p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'GAME_NAME_TAKEN';
  end if;

  select account.minecraft_uuid into v_uuid
  from public.launcher_minecraft_accounts as account
  where account.user_id = p_user_id;

  if found then
    update public.launcher_minecraft_accounts as account
    set game_name = p_game_name, updated_at = now()
    where account.user_id = p_user_id and account.game_name is distinct from p_game_name;
  else
    v_uuid := public.launcher_offline_uuid(p_game_name);
    -- Someone else once played under this name, so its offline data is theirs.
    if exists (select 1 from public.launcher_minecraft_accounts as account where account.minecraft_uuid = v_uuid)
      or exists (
        select 1 from public.launcher_game_name_history as history
        where lower(history.game_name) = lower(p_game_name) and history.user_id <> p_user_id
      ) then
      v_uuid := gen_random_uuid();
    end if;
    insert into public.launcher_minecraft_accounts (user_id, minecraft_uuid, game_name)
    values (p_user_id, v_uuid, p_game_name);
  end if;

  return query select v_uuid, p_game_name;
end;
$$;

create or replace function public.launcher_yggdrasil_join(
  p_token_hash text,
  p_profile_id uuid,
  p_server_id text,
  p_ip text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
begin
  select token.user_id, token.auth_session_id into v_user_id, v_session_id
  from public.launcher_game_auth_tokens as token
  join public.launcher_minecraft_accounts as account on account.user_id = token.user_id
  where token.token_hash = p_token_hash
    and token.expires_at > now()
    and account.minecraft_uuid = p_profile_id;
  if not found then
    return false;
  end if;

  -- A launcher sign-out or a removed membership ends game access right away.
  if not public.launcher_auth_session_active(v_session_id, v_user_id)
    or not exists (select 1 from public.launcher_members as member where member.user_id = v_user_id) then
    return false;
  end if;

  delete from public.launcher_yggdrasil_joins where expires_at < now();
  insert into public.launcher_yggdrasil_joins (server_id, user_id, ip, expires_at)
  values (p_server_id, v_user_id, p_ip, now() + interval '30 seconds')
  on conflict (server_id, user_id) do update set ip = excluded.ip, expires_at = excluded.expires_at;
  return true;
end;
$$;

create or replace function public.launcher_yggdrasil_has_joined(p_game_name text, p_server_id text, p_ip text)
returns table (minecraft_uuid uuid, game_name text, texture_hash text, model text)
language sql
stable
security definer
set search_path = ''
as $$
  select account.minecraft_uuid, account.game_name, skin.texture_hash, skin.model
  from public.launcher_yggdrasil_joins as joined
  join public.launcher_minecraft_accounts as account on account.user_id = joined.user_id
  left join public.launcher_skins as skin on skin.user_id = joined.user_id
  where joined.server_id = p_server_id
    and joined.expires_at > now()
    and lower(account.game_name) = lower(p_game_name)
    and (p_ip is null or joined.ip is null or joined.ip = p_ip)
  limit 1;
$$;

create or replace function public.launcher_yggdrasil_profiles(p_ids uuid[], p_names text[])
returns table (minecraft_uuid uuid, game_name text, texture_hash text, model text)
language sql
stable
security definer
set search_path = ''
as $$
  select account.minecraft_uuid, account.game_name, skin.texture_hash, skin.model
  from public.launcher_minecraft_accounts as account
  left join public.launcher_skins as skin on skin.user_id = account.user_id
  where account.minecraft_uuid = any(coalesce(p_ids, '{}'::uuid[]))
    or lower(account.game_name) in (select lower(name) from unnest(coalesce(p_names, '{}'::text[])) as name);
$$;

revoke all on function public.launcher_offline_uuid(text) from public, anon, authenticated;
revoke all on function public.launcher_claim_minecraft_account(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_join(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_has_joined(text, text, text) from public, anon, authenticated;
revoke all on function public.launcher_yggdrasil_profiles(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.launcher_offline_uuid(text) to service_role;
grant execute on function public.launcher_claim_minecraft_account(uuid, text) to service_role;
grant execute on function public.launcher_yggdrasil_join(text, uuid, text, text) to service_role;
grant execute on function public.launcher_yggdrasil_has_joined(text, text, text) to service_role;
grant execute on function public.launcher_yggdrasil_profiles(uuid[], text[]) to service_role;

-- Admins designate testers from the launcher; the test build and its update
-- channel are only for them.
grant insert, delete on table public.launcher_environment_access to service_role;

-- Skin files are public like Mojang's texture server; names are content hashes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('launcher-skins', 'launcher-skins', true, 65536, array['image/png'])
on conflict (id) do nothing;
