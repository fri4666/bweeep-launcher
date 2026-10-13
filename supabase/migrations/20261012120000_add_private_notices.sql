-- A notice only one member sees, next to the one everyone sees. Rows keep the
-- old shape; target_user_id is null for the everyone-notice and a member's id
-- for a personal one. At most one everyone-notice and one personal notice per
-- member are shown (ended_at is null) at a time; posting a new one ends the
-- one before it for the same audience only.
--
-- launcher-access v30 (and launchers 0.1.38) call
--   launcher_admin_set_notice(p_actor, p_body) / launcher_admin_clear_notice(p_actor)
-- by named arguments. The functions below keep those calls working: the new
-- argument has a default of null, which means "the everyone-notice" as before.
-- The old two- and one-argument functions are dropped first, otherwise a call
-- with only the old arguments would match both and fail as ambiguous.

alter table public.launcher_notices
  add column if not exists target_user_id uuid references auth.users(id) on delete cascade;

drop index if exists public.launcher_notices_one_shown_idx;
create unique index if not exists launcher_notices_one_shown_everyone_idx
  on public.launcher_notices ((true)) where ended_at is null and target_user_id is null;
create unique index if not exists launcher_notices_one_shown_personal_idx
  on public.launcher_notices (target_user_id) where ended_at is null and target_user_id is not null;

drop function if exists public.launcher_admin_set_notice(uuid, text);
drop function if exists public.launcher_admin_clear_notice(uuid);

create or replace function public.launcher_admin_set_notice(p_actor uuid, p_body text, p_target uuid default null)
returns table (id uuid, body text, created_at timestamptz, target_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  -- Two admins posting at once run one after the other, so one notice per audience is left shown.
  perform pg_advisory_xact_lock(hashtextextended('launcher_notice', 0));
  perform public.launcher_require_admin(p_actor);
  if p_target is not null and not exists (
    select 1 from public.launcher_members as member where member.user_id = p_target
  ) then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  update public.launcher_notices as notice set ended_at = now()
    where notice.ended_at is null and notice.target_user_id is not distinct from p_target;
  insert into public.launcher_notices (body, created_by, target_user_id)
    values (btrim(p_body), p_actor, p_target) returning launcher_notices.id into v_id;
  perform public.launcher_log_admin_action(
    p_actor, 'set_notice', v_id::text,
    jsonb_build_object('body', btrim(p_body)) || case when p_target is null then '{}'::jsonb else jsonb_build_object('target', p_target) end
  );
  return query
    select notice.id, notice.body, notice.created_at, notice.target_user_id
    from public.launcher_notices as notice where notice.id = v_id;
end;
$$;

create or replace function public.launcher_admin_clear_notice(p_actor uuid, p_target uuid default null)
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
  update public.launcher_notices as notice set ended_at = now()
    where notice.ended_at is null and notice.target_user_id is not distinct from p_target
    returning notice.id into v_id;
  if found then
    perform public.launcher_log_admin_action(
      p_actor, 'clear_notice', v_id::text,
      case when p_target is null then '{}'::jsonb else jsonb_build_object('target', p_target) end
    );
  end if;
end;
$$;

revoke all on function public.launcher_admin_set_notice(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.launcher_admin_clear_notice(uuid, uuid) from public, anon, authenticated;
grant execute on function public.launcher_admin_set_notice(uuid, text, uuid) to service_role;
grant execute on function public.launcher_admin_clear_notice(uuid, uuid) to service_role;
