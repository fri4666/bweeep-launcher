-- launcher-access now counts, lists and revokes the caller's own invites.
-- service_role previously only had INSERT, so those queries failed with 42501.
-- code_hash stays unreadable; only revoked_at can be changed.
grant select (id, created_by, expires_at, max_uses, uses, revoked_at, created_at)
  on table public.launcher_invites to service_role;
grant update (revoked_at) on table public.launcher_invites to service_role;
