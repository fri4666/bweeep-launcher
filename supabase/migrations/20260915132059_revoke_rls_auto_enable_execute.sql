
-- rls_auto_enable is an internal DDL event-trigger function.  It does not
-- need to be callable through the exposed public schema.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
