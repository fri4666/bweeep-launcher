-- Only the Edge Function's service-role client can read or change this allowlist.
-- The guards also allow this migration to be recorded after a manual recovery apply.
do $$ begin
  create type public.launcher_environment as enum ('test');
exception when duplicate_object then null;
end $$;

create table if not exists public.launcher_environment_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  environment public.launcher_environment not null,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, environment)
);

alter table public.launcher_environment_access enable row level security;
revoke all on public.launcher_environment_access from anon, authenticated;
