-- Why the Bweeep Yggdrasil API turned a player away, so the launcher can say
-- it in one line and admins can see it. Kept for seven days. The yggdrasil
-- function records a refusal after answering it with the same "no" as
-- before, so the join and hasJoined answers do not change.

create table if not exists public.launcher_auth_failures (
  id bigint generated always as identity primary key,
  -- Null when nobody can be named, e.g. an unknown token or a client that never joined.
  user_id uuid references auth.users(id) on delete cascade,
  game_name text check (game_name is null or game_name ~ '^[A-Za-z0-9_]{1,16}$'),
  -- Which API root the request came through: /yggdrasil or /yggdrasil/testers.
  audience text not null check (audience in ('members', 'testers')),
  reason text not null check (reason in (
    'unknown_token', 'token_revoked', 'token_expired', 'signed_out', 'not_member',
    'profile_mismatch', 'no_join', 'name_mismatch', 'testers_only', 'unknown'
  )),
  created_at timestamptz not null default now()
);
create index if not exists launcher_auth_failures_created_at_idx on public.launcher_auth_failures (created_at);
create index if not exists launcher_auth_failures_user_idx on public.launcher_auth_failures (user_id, created_at desc);

-- Game tokens are deleted when they are replaced, revoked or their member is
-- removed. Remembering whose they were for a day tells "revoked" apart from
-- "never existed". No foreign key: the row may outlive a deleted user by a day.
create table if not exists public.launcher_game_auth_retired (
  token_hash text primary key check (token_hash ~ '^[A-F0-9]{64}$'),
  user_id uuid not null,
  retired_at timestamptz not null default now()
);

alter table public.launcher_auth_failures enable row level security;
alter table public.launcher_game_auth_retired enable row level security;
revoke all on table public.launcher_auth_failures, public.launcher_game_auth_retired from public, anon, authenticated;
grant select on table public.launcher_auth_failures to service_role;

create or replace function public.launcher_game_auth_token_retired()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.launcher_game_auth_retired where retired_at < now() - interval '1 day';
  if old.expires_at > now() then
    insert into public.launcher_game_auth_retired (token_hash, user_id)
    values (old.token_hash, old.user_id)
    on conflict (token_hash) do nothing;
  end if;
  return old;
end;
$$;
drop trigger if exists launcher_game_auth_tokens_retired on public.launcher_game_auth_tokens;
create trigger launcher_game_auth_tokens_retired
after delete on public.launcher_game_auth_tokens
for each row
execute function public.launcher_game_auth_token_retired();

-- The Yggdrasil endpoints are public, so a flood of bad requests is capped
-- instead of filling the table. Rows older than seven days go first.
create or replace function public.launcher_insert_auth_failure(
  p_user_id uuid,
  p_game_name text,
  p_audience text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.launcher_auth_failures where created_at < now() - interval '7 days';
  if (select count(*) from public.launcher_auth_failures where created_at > now() - interval '10 minutes') >= 500 then
    return;
  end if;
  if p_user_id is null and exists (
    select 1 from public.launcher_auth_failures as failure
    where failure.user_id is null and failure.reason = p_reason
      and failure.game_name is not distinct from p_game_name
      and failure.created_at > now() - interval '1 minute'
  ) then
    return;
  end if;
  insert into public.launcher_auth_failures (user_id, game_name, audience, reason)
  values (p_user_id, case when p_game_name ~ '^[A-Za-z0-9_]{1,16}$' then p_game_name end, p_audience, p_reason);
end;
$$;

-- A refused join: the client's token did not open a join.
create or replace function public.launcher_record_join_failure(p_token_hash text, p_profile_id uuid, p_audience text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session_id uuid;
  v_expires_at timestamptz;
  v_reason text;
begin
  select token.user_id, token.auth_session_id, token.expires_at
  into v_user_id, v_session_id, v_expires_at
  from public.launcher_game_auth_tokens as token
  where token.token_hash = p_token_hash;

  if not found then
    select retired.user_id into v_user_id
    from public.launcher_game_auth_retired as retired
    where retired.token_hash = p_token_hash;
    v_reason := case when v_user_id is null then 'unknown_token' else 'token_revoked' end;
  elsif v_expires_at <= now() then
    v_reason := 'token_expired';
  elsif not public.launcher_auth_session_active(v_session_id, v_user_id) then
    v_reason := 'signed_out';
  elsif not exists (
    select 1 from public.launcher_minecraft_accounts as account
    where account.user_id = v_user_id and account.minecraft_uuid = p_profile_id
  ) then
    v_reason := 'profile_mismatch';
  else
    v_reason := 'unknown';
  end if;
  if v_user_id is not null and not exists (select 1 from public.launcher_members as member where member.user_id = v_user_id) then
    v_reason := 'not_member';
  end if;

  perform public.launcher_insert_auth_failure(
    v_user_id,
    (select account.game_name from public.launcher_minecraft_accounts as account where account.user_id = v_user_id),
    p_audience,
    v_reason
  );
  return v_reason;
end;
$$;

-- A refused hasJoined: the server asked about a player the API would not vouch for.
create or replace function public.launcher_record_has_joined_failure(p_game_name text, p_server_id text, p_testers_only boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_name text;
  v_role public.launcher_member_role;
  v_reason text;
begin
  select joined.user_id, account.game_name, member.role
  into v_user_id, v_name, v_role
  from public.launcher_yggdrasil_joins as joined
  left join public.launcher_minecraft_accounts as account on account.user_id = joined.user_id
  left join public.launcher_members as member on member.user_id = joined.user_id
  where joined.server_id = p_server_id and joined.expires_at > now()
  order by lower(account.game_name) = lower(p_game_name) desc nulls last
  limit 1;

  if not found then
    -- Nobody joined with this server id: a client that is not the launcher's,
    -- or one whose join was refused and already recorded.
    v_reason := 'no_join';
  elsif v_name is null or lower(v_name) <> lower(p_game_name) then
    v_reason := 'name_mismatch';
  elsif v_role is null then
    v_reason := 'not_member';
  elsif p_testers_only and v_role <> 'admin' and not exists (
    select 1 from public.launcher_environment_access as access
    where access.user_id = v_user_id and access.environment = 'test'
  ) then
    v_reason := 'testers_only';
  else
    v_reason := 'unknown';
  end if;

  perform public.launcher_insert_auth_failure(
    v_user_id,
    p_game_name,
    case when p_testers_only then 'testers' else 'members' end,
    v_reason
  );
  return v_reason;
end;
$$;

revoke all on function public.launcher_game_auth_token_retired() from public, anon, authenticated;
revoke all on function public.launcher_insert_auth_failure(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.launcher_record_join_failure(text, uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_record_has_joined_failure(text, text, boolean) from public, anon, authenticated;
grant execute on function public.launcher_record_join_failure(text, uuid, text) to service_role;
grant execute on function public.launcher_record_has_joined_failure(text, text, boolean) to service_role;

-- Diagnostics a player sends from the launcher after an error: the end of the
-- game log and of the launcher log, with tokens masked. The bucket is private;
-- admins open a file through a short-lived signed URL from launcher-access.
create table if not exists public.launcher_diagnostics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  size_bytes integer not null check (size_bytes between 0 and 300000),
  created_at timestamptz not null default now()
);
create index if not exists launcher_diagnostics_user_idx on public.launcher_diagnostics (user_id, created_at desc);
alter table public.launcher_diagnostics enable row level security;
revoke all on table public.launcher_diagnostics from public, anon, authenticated;
grant select, delete on table public.launcher_diagnostics to service_role;

-- One upload per member every ten minutes. Returns the new row id (its file
-- is "<id>.txt") and the files of rows older than seven days to remove.
create or replace function public.launcher_begin_diagnostics(p_user_id uuid, p_size_bytes integer)
returns table (diagnostic_id uuid, expired_ids uuid[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_expired uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('launcher_diagnostics:' || p_user_id::text, 0));
  if exists (
    select 1 from public.launcher_diagnostics as diagnostic
    where diagnostic.user_id = p_user_id and diagnostic.created_at > now() - interval '10 minutes'
  ) then
    raise exception using errcode = 'P0001', message = 'DIAGNOSTICS_RATE_LIMITED';
  end if;
  with expired as (
    delete from public.launcher_diagnostics as diagnostic
    where diagnostic.created_at < now() - interval '7 days'
    returning diagnostic.id
  )
  select coalesce(array_agg(expired.id), '{}'::uuid[]) into v_expired from expired;
  insert into public.launcher_diagnostics (user_id, size_bytes) values (p_user_id, p_size_bytes)
  returning id into v_id;
  return query select v_id, v_expired;
end;
$$;
revoke all on function public.launcher_begin_diagnostics(uuid, integer) from public, anon, authenticated;
grant execute on function public.launcher_begin_diagnostics(uuid, integer) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('launcher-diagnostics', 'launcher-diagnostics', false, 300000, array['text/plain'])
on conflict (id) do nothing;
