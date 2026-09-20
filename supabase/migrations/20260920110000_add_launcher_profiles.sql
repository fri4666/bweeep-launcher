create table if not exists public.launcher_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  game_name text not null,
  updated_at timestamptz not null default now(),
  constraint launcher_profiles_game_name_check
    check (game_name ~ '^[A-Za-z0-9_]{3,16}$')
);

alter table public.launcher_profiles enable row level security;
revoke all on table public.launcher_profiles from public, anon, authenticated;
grant select, insert, update on table public.launcher_profiles to service_role;
