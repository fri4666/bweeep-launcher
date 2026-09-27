create table if not exists public.launcher_game_name_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  game_name text not null check (game_name ~ '^[A-Za-z0-9_]{3,16}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, game_name)
);

alter table public.launcher_game_name_history enable row level security;
revoke all on table public.launcher_game_name_history from public, anon, authenticated;
grant select, insert on table public.launcher_game_name_history to service_role;

insert into public.launcher_game_name_history (user_id, game_name)
select user_id, game_name
from public.launcher_profiles
on conflict (user_id, game_name) do nothing;

create or replace function public.record_launcher_game_name_history()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.game_name is distinct from new.game_name then
    insert into public.launcher_game_name_history (user_id, game_name)
    values (old.user_id, old.game_name)
    on conflict (user_id, game_name) do nothing;
  end if;

  insert into public.launcher_game_name_history (user_id, game_name)
  values (new.user_id, new.game_name)
  on conflict (user_id, game_name) do nothing;

  return new;
end;
$$;

revoke all on function public.record_launcher_game_name_history() from public, anon, authenticated;
grant execute on function public.record_launcher_game_name_history() to service_role;

create trigger launcher_profiles_game_name_history
after insert or update of game_name on public.launcher_profiles
for each row
execute function public.record_launcher_game_name_history();
