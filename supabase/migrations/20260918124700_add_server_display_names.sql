create table if not exists public.launcher_display_names (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint launcher_display_names_length_check
    check (char_length(display_name) between 2 and 16),
  constraint launcher_display_names_characters_check
    check (display_name ~ '^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9_ ]+$'),
  constraint launcher_display_names_spacing_check
    check (display_name = btrim(display_name) and display_name !~ '  ')
);

alter table public.launcher_display_names enable row level security;
revoke all on table public.launcher_display_names from public, anon, authenticated;
grant select, insert on table public.launcher_display_names to service_role;

create table if not exists public.launcher_game_sessions (
  session_hash text primary key check (session_hash ~ '^[A-F0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.launcher_game_sessions enable row level security;
create index if not exists launcher_game_sessions_user_id_idx
  on public.launcher_game_sessions (user_id);
create index if not exists launcher_game_sessions_expires_at_idx
  on public.launcher_game_sessions (expires_at);
revoke all on table public.launcher_game_sessions from public, anon, authenticated;
grant select, insert, delete on table public.launcher_game_sessions to service_role;

create or replace function public.set_launcher_display_name_once(
  p_session_hash text,
  p_display_name text
)
returns table (
  ok boolean,
  saved_name text,
  already_set boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_inserted_name text;
begin
  delete from public.launcher_game_sessions as session
  where session.session_hash = p_session_hash
    and session.expires_at > now()
  returning session.user_id into v_user_id;

  if v_user_id is null then
    return;
  end if;

  insert into public.launcher_display_names (user_id, display_name)
  values (v_user_id, p_display_name)
  on conflict (user_id) do nothing
  returning display_name into v_inserted_name;

  if v_inserted_name is not null then
    return query select true, v_inserted_name, false;
    return;
  end if;

  return query
  select true, names.display_name, true
  from public.launcher_display_names as names
  where names.user_id = v_user_id;
end;
$$;

revoke all on function public.set_launcher_display_name_once(text, text)
  from public, anon, authenticated;
grant execute on function public.set_launcher_display_name_once(text, text)
  to service_role;
