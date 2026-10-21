-- Group-aware redemption from the deployed function, used only in the disposable PostgreSQL fixture.
CREATE OR REPLACE FUNCTION public.redeem_launcher_invite(p_code_hash text, p_user_id uuid)
 RETURNS TABLE(ok boolean, message text, member_role launcher_member_role)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare invite public.launcher_invites%rowtype; existing_role public.launcher_member_role;
begin
  select role into existing_role from public.launcher_members where user_id = p_user_id;
  if found then return query select true, '이미 런처 사용 권한이 있습니다.', existing_role; return; end if;
  select * into invite from public.launcher_invites where code_hash = p_code_hash for update;
  if not found then return query select false, '초대 코드를 찾지 못했습니다.', null::public.launcher_member_role; return; end if;
  if invite.revoked_at is not null or invite.expires_at <= now() or invite.uses >= invite.max_uses then
    return query select false, '사용할 수 없는 초대 코드입니다.', null::public.launcher_member_role; return;
  end if;
  insert into public.launcher_members (user_id, group_id) values (p_user_id, invite.group_id);
  update public.launcher_invites set uses = uses + 1 where id = invite.id;
  return query select true, '초대가 등록되었습니다.', 'member'::public.launcher_member_role;
end; $function$
;