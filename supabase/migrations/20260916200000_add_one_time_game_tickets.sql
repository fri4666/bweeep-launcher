create table if not exists public.launcher_game_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[A-F0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  discord_id text not null check (discord_id ~ '^[0-9]{15,22}$'),
  role public.launcher_member_role not null,
  game_name text not null check (game_name ~ '^[A-Za-z0-9_]{3,16}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.launcher_game_tickets enable row level security;

create index if not exists launcher_game_tickets_user_id_idx
  on public.launcher_game_tickets (user_id);
create index if not exists launcher_game_tickets_expires_at_idx
  on public.launcher_game_tickets (expires_at);

revoke all on table public.launcher_game_tickets from anon, authenticated;
grant select, insert, delete on table public.launcher_game_tickets to service_role;

create or replace function public.consume_launcher_game_ticket(
  p_ticket_hash text,
  p_game_name text
)
returns table (
  user_id uuid,
  discord_id text,
  member_role public.launcher_member_role
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from public.launcher_game_tickets as ticket
  where ticket.ticket_hash = p_ticket_hash
    and ticket.game_name = p_game_name
    and ticket.expires_at > now()
  returning ticket.user_id, ticket.discord_id, ticket.role;
end;
$$;

revoke all on function public.consume_launcher_game_ticket(text, text) from public, anon, authenticated;
grant execute on function public.consume_launcher_game_ticket(text, text) to service_role;
