-- launcher-access verifies tokens locally with getClaims, which only checks the
-- signature and expiry. Signing out deletes the auth.sessions row, so checking
-- it blocks a signed-out token right away instead of when the token expires.
create or replace function public.launcher_auth_session_active(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.sessions s
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
  );
$$;

revoke all on function public.launcher_auth_session_active(uuid, uuid) from public, anon, authenticated;
grant execute on function public.launcher_auth_session_active(uuid, uuid) to service_role;
