-- Removing a member also ends what they could still hand out or use: their
-- open invite codes (which would keep admitting people), unused game tickets
-- and name-setting sessions. Test access, game tokens and pending joins were
-- already removed.
create or replace function public.launcher_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.launcher_environment_access where user_id = old.user_id;
  delete from public.launcher_game_auth_tokens where user_id = old.user_id;
  delete from public.launcher_yggdrasil_joins where user_id = old.user_id;
  delete from public.launcher_game_tickets where user_id = old.user_id;
  delete from public.launcher_game_sessions where user_id = old.user_id;
  update public.launcher_invites set revoked_at = now()
  where created_by = old.user_id and revoked_at is null;
  return old;
end;
$$;

revoke all on function public.launcher_member_removed() from public, anon, authenticated;
