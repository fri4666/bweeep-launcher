-- A running game keeps its token alive: while the game is open the launcher
-- moves the expiry to "now + p_hours" every hour, so a long session can still
-- rejoin after half a day. Only the caller's own unexpired token can be
-- extended, and only while they are a member and still signed in. Returns the
-- new expiry, or null when nothing was extended.
create or replace function public.launcher_extend_game_auth(p_user_id uuid, p_token_hash text, p_hours integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
begin
  if p_hours is null or p_hours < 1 or p_hours > 12 then
    raise exception using errcode = '22023', message = 'INVALID_HOURS';
  end if;
  update public.launcher_game_auth_tokens as token
  set expires_at = now() + make_interval(hours => p_hours)
  where token.token_hash = p_token_hash
    and token.user_id = p_user_id
    and token.expires_at > now()
    and exists (select 1 from public.launcher_members as member where member.user_id = p_user_id)
    and public.launcher_auth_session_active(token.auth_session_id, p_user_id)
  returning token.expires_at into v_expires_at;
  return v_expires_at;
end;
$$;

revoke all on function public.launcher_extend_game_auth(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.launcher_extend_game_auth(uuid, text, integer) to service_role;
