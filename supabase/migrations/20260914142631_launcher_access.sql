create type public.launcher_member_role as enum ('admin', 'member');
create table public.launcher_members (user_id uuid primary key references auth.users(id) on delete cascade, role public.launcher_member_role not null default 'member', invited_at timestamptz not null default now());
create table public.launcher_invites (id uuid primary key default gen_random_uuid(), code_hash text not null unique, created_by uuid not null references auth.users(id), expires_at timestamptz not null, max_uses integer not null default 1 check (max_uses between 1 and 20), uses integer not null default 0 check (uses >= 0), revoked_at timestamptz, created_at timestamptz not null default now());
create table public.launcher_releases (id uuid primary key default gen_random_uuid(), pack_id text not null check (pack_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'), version text not null, manifest jsonb not null, active boolean not null default true, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), unique (pack_id, version));
create unique index launcher_releases_one_active_per_pack on public.launcher_releases (pack_id) where active;
alter table public.launcher_members enable row level security;
alter table public.launcher_invites enable row level security;
alter table public.launcher_releases enable row level security;
revoke all on public.launcher_members, public.launcher_invites, public.launcher_releases from anon, authenticated;
create or replace function public.redeem_launcher_invite(p_code_hash text, p_user_id uuid)
returns table (ok boolean, message text, member_role public.launcher_member_role)
language plpgsql security definer set search_path = public, pg_temp as $$
declare invite public.launcher_invites%rowtype; existing_role public.launcher_member_role;
begin
  select role into existing_role from public.launcher_members where user_id = p_user_id;
  if found then return query select true, '이미 런처 사용 권한이 있습니다.', existing_role; return; end if;
  select * into invite from public.launcher_invites where code_hash = p_code_hash for update;
  if not found then return query select false, '초대 코드를 찾지 못했습니다.', null::public.launcher_member_role; return; end if;
  if invite.revoked_at is not null or invite.expires_at <= now() or invite.uses >= invite.max_uses then return query select false, '사용할 수 없는 초대 코드입니다.', null::public.launcher_member_role; return; end if;
  insert into public.launcher_members (user_id) values (p_user_id);
  update public.launcher_invites set uses = uses + 1 where id = invite.id;
  return query select true, '초대가 등록되었습니다.', 'member'::public.launcher_member_role;
end; $$;
revoke all on function public.redeem_launcher_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_launcher_invite(text, uuid) to service_role;
