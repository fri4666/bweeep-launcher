-- The announcement admins show to every member in the launcher. At most one
-- is shown at a time; posting a new one ends the one before it, and ended
-- ones stay as a record. launcher-access reads and writes it for members.

create table if not exists public.launcher_notices (
  id uuid primary key default gen_random_uuid(),
  body text not null check (length(btrim(body)) between 1 and 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists launcher_notices_one_shown_idx on public.launcher_notices ((true)) where ended_at is null;
alter table public.launcher_notices enable row level security;
revoke all on table public.launcher_notices from public, anon, authenticated;
grant select on table public.launcher_notices to service_role;

create or replace function public.launcher_admin_set_notice(p_actor uuid, p_body text)
returns table (id uuid, body text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  -- Two admins posting at once run one after the other, so one notice is left shown.
  perform pg_advisory_xact_lock(hashtextextended('launcher_notice', 0));
  perform public.launcher_require_admin(p_actor);
  update public.launcher_notices as notice set ended_at = now() where notice.ended_at is null;
  insert into public.launcher_notices (body, created_by) values (btrim(p_body), p_actor) returning launcher_notices.id into v_id;
  perform public.launcher_log_admin_action(p_actor, 'set_notice', v_id::text, jsonb_build_object('body', btrim(p_body)));
  return query select notice.id, notice.body, notice.created_at from public.launcher_notices as notice where notice.id = v_id;
end;
$$;

create or replace function public.launcher_admin_clear_notice(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('launcher_notice', 0));
  perform public.launcher_require_admin(p_actor);
  update public.launcher_notices as notice set ended_at = now() where notice.ended_at is null returning notice.id into v_id;
  if found then
    perform public.launcher_log_admin_action(p_actor, 'clear_notice', v_id::text, '{}'::jsonb);
  end if;
end;
$$;

revoke all on function public.launcher_admin_set_notice(uuid, text) from public, anon, authenticated;
revoke all on function public.launcher_admin_clear_notice(uuid) from public, anon, authenticated;
grant execute on function public.launcher_admin_set_notice(uuid, text) to service_role;
grant execute on function public.launcher_admin_clear_notice(uuid) to service_role;
