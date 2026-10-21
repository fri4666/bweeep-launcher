-- Serialize policy with member role/removal/group changes; preserve deployed group inheritance.
-- Keep one RPC signature: omitted p_group_id remains compatible with older callers.
drop function if exists public.launcher_create_invite(uuid, text, integer);
create or replace function public.launcher_create_invite(
  p_user_id uuid, p_code_hash text, p_max_uses integer default 1, p_group_id text default null
)
returns table (id uuid, expires_at timestamptz, max_uses integer, group_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.launcher_member_role;
  v_member_group text;
  v_group text;
  v_has_member_group boolean;
  v_has_invite_group boolean;
  v_now timestamptz;
  v_max_uses integer;
begin
  select member.role, coalesce(to_jsonb(member)->>'group_id', 'original')
  into v_role, v_member_group
  from public.launcher_members as member
  where member.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_MEMBER';
  end if;
  select exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.launcher_members'::regclass and attname = 'group_id' and attnum > 0 and not attisdropped
  ), exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.launcher_invites'::regclass and attname = 'group_id' and attnum > 0 and not attisdropped
  ) into v_has_member_group, v_has_invite_group;
  if v_has_member_group is distinct from v_has_invite_group then
    raise exception using errcode = 'P0001', message = 'INCOMPATIBLE_INVITE_GROUP_SCHEMA';
  end if;
  v_group := case when v_role = 'admin' then coalesce(p_group_id, v_member_group) else v_member_group end;
  if v_group not in ('original', 'friend-a', 'friend-b')
      or (not v_has_invite_group and v_group <> 'original') then
    raise exception using errcode = 'P0001', message = 'INVALID_INVITE_GROUP';
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
  if v_has_invite_group then
    return query execute
      'insert into public.launcher_invites as invite (code_hash, created_by, expires_at, max_uses, group_id)
       values ($1, $2, $3, $4, $5)
       returning invite.id, invite.expires_at, invite.max_uses, invite.group_id'
      using p_code_hash, p_user_id,
        v_now + case when v_role = 'admin' then interval '14 days' else interval '7 days' end,
        v_max_uses, v_group;
  else
    return query
    insert into public.launcher_invites as invite (code_hash, created_by, expires_at, max_uses)
    values (p_code_hash, p_user_id, v_now + case when v_role = 'admin' then interval '14 days' else interval '7 days' end, v_max_uses)
    returning invite.id, invite.expires_at, invite.max_uses, 'original'::text;
  end if;
end;
$$;

-- Return one JSON value so pagination cannot hide older active invitations.
create or replace function public.launcher_list_invites(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.launcher_member_role;
  v_group text;
begin
  select member.role, coalesce(to_jsonb(member)->>'group_id', 'original')
  into v_role, v_group from public.launcher_members as member where member.user_id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_MEMBER';
  end if;
  return jsonb_build_object(
    'role', v_role, 'groupId', v_group,
    'maxUsesLimit', case when v_role = 'admin' then 20 else 1 end,
    'activeLimit', case when v_role = 'admin' then null::integer else 3 end,
    'invites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', invite.id, 'expiresAt', invite.expires_at, 'maxUses', invite.max_uses,
        'uses', invite.uses, 'createdAt', invite.created_at,
        'groupId', coalesce(to_jsonb(invite)->>'group_id', 'original')
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

revoke all on function public.launcher_create_invite(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.launcher_list_invites(uuid) from public, anon, authenticated;
revoke all on function public.launcher_revoke_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.launcher_create_invite(uuid, text, integer, text) to service_role;
grant execute on function public.launcher_list_invites(uuid) to service_role;
grant execute on function public.launcher_revoke_invite(uuid, uuid) to service_role;
revoke insert on table public.launcher_invites from public, anon, authenticated, service_role;
-- Clear all existing column grants, including deployed extensions such as group_id.
do $$
declare v_column name;
begin
  for v_column in select attname from pg_catalog.pg_attribute
    where attrelid = 'public.launcher_invites'::regclass and attnum > 0 and not attisdropped
  loop
    execute format('revoke insert (%I) on table public.launcher_invites from public, anon, authenticated, service_role', v_column);
  end loop;
end;
$$;
