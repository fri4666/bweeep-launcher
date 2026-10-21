-- Serialize creation with other creations, role changes and member removal.
-- The Edge function no longer counts a bounded slice of invite history.
create or replace function public.launcher_create_invite(p_user_id uuid, p_code_hash text, p_max_uses integer default 1)
returns table (id uuid, expires_at timestamptz, max_uses integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.launcher_member_role;
  v_now timestamptz;
  v_max_uses integer;
begin
  select member.role into v_role
  from public.launcher_members as member
  where member.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_MEMBER';
  end if;
  v_now := clock_timestamp();
  if v_role = 'member' and (
    select count(*) from public.launcher_invites as invite
    where invite.created_by = p_user_id and invite.revoked_at is null
      and invite.expires_at > v_now and invite.uses < invite.max_uses
  ) >= 3 then
    raise exception using errcode = 'P0001', message = 'INVITE_LIMIT_REACHED';
  end if;
  v_max_uses := case when v_role = 'admin' then least(greatest(coalesce(p_max_uses, 1), 1), 20) else 1 end;
  return query
  insert into public.launcher_invites (code_hash, created_by, expires_at, max_uses)
  values (p_code_hash, p_user_id, v_now + case when v_role = 'admin' then interval '14 days' else interval '7 days' end, v_max_uses)
  returning launcher_invites.id, launcher_invites.expires_at, launcher_invites.max_uses;
end;
$$;

-- One JSON value avoids the Data API row limit hiding an administrator's
-- older active group codes. Codes and their hashes are never returned.
create or replace function public.launcher_list_invites(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.launcher_member_role;
begin
  select member.role into v_role from public.launcher_members as member where member.user_id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_MEMBER';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'maxUsesLimit', case when v_role = 'admin' then 20 else 1 end,
    'activeLimit', case when v_role = 'admin' then null::integer else 3 end,
    'invites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', invite.id, 'expiresAt', invite.expires_at, 'maxUses', invite.max_uses,
        'uses', invite.uses, 'createdAt', invite.created_at
      ) order by invite.created_at desc, invite.id), '[]'::jsonb)
      from public.launcher_invites as invite
      where invite.created_by = p_user_id and invite.revoked_at is null
        and invite.expires_at > now() and invite.uses < invite.max_uses
    )
  );
end;
$$;

create or replace function public.launcher_revoke_invite(p_user_id uuid, p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.launcher_invites as invite set revoked_at = now()
  where invite.id = p_invite_id and invite.created_by = p_user_id
    and invite.revoked_at is null and invite.expires_at > now() and invite.uses < invite.max_uses;
  return found;
end;
$$;

revoke all on function public.launcher_create_invite(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.launcher_list_invites(uuid) from public, anon, authenticated;
revoke all on function public.launcher_revoke_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.launcher_create_invite(uuid, text, integer) to service_role;
grant execute on function public.launcher_list_invites(uuid) to service_role;
grant execute on function public.launcher_revoke_invite(uuid, uuid) to service_role;
-- Keep the locking policy authoritative for every service-role creation.
revoke insert on table public.launcher_invites from public, anon, authenticated, service_role;
-- A table-level REVOKE alone does not clear earlier column-level grants.
revoke insert (id, code_hash, created_by, expires_at, max_uses, uses, revoked_at, created_at)
  on table public.launcher_invites from public, anon, authenticated, service_role;
