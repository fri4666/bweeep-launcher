create table if not exists public.launcher_host_control (
 cluster_id text primary key default 'main',
 policy jsonb not null default '{"primaryNode":"vps","automatic":false,"failureSeconds":90,"syncMinutes":5,"maxSnapshotMinutes":10,"allowRecovery":false}'::jsonb,
 revision bigint not null default 1,
 owner_node text not null default 'vps' check(owner_node in ('vps','pc')),
 owner_session uuid,
 epoch bigint not null default 1,
 lease_until timestamptz not null default now(),
 requested_node text check(requested_node in ('vps','pc')),
 handoff_node text check(handoff_node in ('vps','pc')),
 updated_at timestamptz not null default now()
);
create table if not exists public.launcher_host_nodes (
 cluster_id text not null references public.launcher_host_control(cluster_id) on delete cascade,
 node text not null check(node in ('vps','pc')),
 last_seen timestamptz,
 status text not null default 'not_ready',
 snapshot_at timestamptz,
 snapshot_source text check(snapshot_source in ('vps','pc')),
 snapshot_epoch bigint,
 snapshot_id text,
 primary key(cluster_id,node)
);
alter table public.launcher_host_control enable row level security;
alter table public.launcher_host_nodes enable row level security;
revoke all on public.launcher_host_control,public.launcher_host_nodes from public,anon,authenticated;
grant all on public.launcher_host_control,public.launcher_host_nodes to service_role;
insert into public.launcher_host_control(cluster_id) values('main') on conflict(cluster_id) do nothing;

create or replace function public.launcher_host_state(p_cluster text default 'main') returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('policy',c.policy,'revision',c.revision,'activeNode',c.owner_node,'epoch',c.epoch,'leaseUntil',c.lease_until,'requestedNode',c.requested_node,
 'nodes',coalesce((select jsonb_agg(jsonb_build_object('node',n.node,'lastSeen',n.last_seen,'status',n.status,'snapshotAt',n.snapshot_at,'snapshotSource',n.snapshot_source,'snapshotEpoch',n.snapshot_epoch,'snapshotId',n.snapshot_id) order by n.node) from public.launcher_host_nodes n where n.cluster_id=c.cluster_id),'[]'::jsonb))
 from public.launcher_host_control c where c.cluster_id=p_cluster
$$;

create or replace function public.launcher_host_admin(p_actor uuid,p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.launcher_host_control; p jsonb;
begin
 if not exists(select 1 from public.launcher_members where user_id=p_actor and role='admin') then raise exception 'NOT_ADMIN'; end if;
 select * into c from public.launcher_host_control where cluster_id='main' for update;
 if p_action='configure' then
  if (p_payload->>'revision')::bigint is distinct from c.revision then raise exception 'HOST_POLICY_CHANGED'; end if;
  p=p_payload->'policy';
  if jsonb_typeof(p) is distinct from 'object'
   or jsonb_typeof(p->'failureSeconds') is distinct from 'number'
   or jsonb_typeof(p->'syncMinutes') is distinct from 'number'
   or jsonb_typeof(p->'maxSnapshotMinutes') is distinct from 'number' or (p->>'primaryNode') not in ('vps','pc')
   or jsonb_typeof(p->'automatic')<>'boolean' or jsonb_typeof(p->'allowRecovery')<>'boolean'
   or (p->>'failureSeconds')::int not between 90 and 1800
   or (p->>'syncMinutes')::int not between 1 and 60
   or (p->>'maxSnapshotMinutes')::int not between 1 and 120
   or (p->>'syncMinutes')::int>(p->>'maxSnapshotMinutes')::int
   or (p->>'automatic')::boolean and not (p->>'allowRecovery')::boolean
   or not(p ?& array['primaryNode','automatic','failureSeconds','syncMinutes','maxSnapshotMinutes','allowRecovery'])
   or (select count(*) from jsonb_object_keys(p))<>6 then raise exception 'INVALID_HOST_POLICY'; end if;
  update public.launcher_host_control set policy=p,requested_node=case when p->>'primaryNode' is distinct from c.policy->>'primaryNode' then case when p->>'primaryNode'=owner_node then null else p->>'primaryNode' end else requested_node end,revision=revision+1,updated_at=clock_timestamp() where cluster_id='main';
 elsif p_action='switch' then
  if p_payload->>'node' not in ('vps','pc') or p_payload->>'node' is null then raise exception 'INVALID_HOST_NODE'; end if;
  if p_payload->>'node'=c.owner_node then
   update public.launcher_host_control set requested_node=null,handoff_node=null,revision=revision+1,updated_at=clock_timestamp() where cluster_id='main';
   return public.launcher_host_state('main');
  end if;
  update public.launcher_host_control set requested_node=p_payload->>'node',revision=revision+1,updated_at=clock_timestamp() where cluster_id='main';
 elsif p_action<>'read' then raise exception 'INVALID_HOST_ACTION';
 end if;
 return public.launcher_host_state('main');
end $$;

create or replace function public.launcher_host_snapshot(p_cluster text,p_node text,p_source text,p_epoch bigint,p_at timestamptz,p_snapshot text) returns boolean
language plpgsql security definer set search_path='' as $$
declare c public.launcher_host_control;
begin
 if p_node not in ('vps','pc') or p_source not in ('vps','pc') or p_node=p_source
  or p_snapshot !~ '^[A-Za-z0-9_.-]{1,100}$' or p_at>clock_timestamp()+interval '10 seconds' then raise exception 'INVALID_HOST_SNAPSHOT'; end if;
 select * into c from public.launcher_host_control where cluster_id=p_cluster for update;
 if c.owner_node<>p_source or c.epoch<>p_epoch then return false; end if;
 insert into public.launcher_host_nodes(cluster_id,node,snapshot_at,snapshot_source,snapshot_epoch,snapshot_id,status)
 values(p_cluster,p_node,p_at,p_source,p_epoch,p_snapshot,'standby_ready')
 on conflict(cluster_id,node) do update set snapshot_at=excluded.snapshot_at,snapshot_source=excluded.snapshot_source,snapshot_epoch=excluded.snapshot_epoch,snapshot_id=excluded.snapshot_id,status='standby_ready';
 return true;
end $$;

create or replace function public.launcher_host_poll(p_cluster text,p_node text,p_session uuid,p_claim boolean default false,p_status text default 'standby') returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.launcher_host_control; n public.launcher_host_nodes; t timestamptz=clock_timestamp(); granted boolean=false; eligible boolean=false; host text; previous_owner text;
begin
 if p_node not in ('vps','pc') or p_session is null or p_status not in ('standby','active','not_ready','syncing','standby_ready','fenced','error') then raise exception 'INVALID_HOST_AGENT'; end if;
 select * into c from public.launcher_host_control where cluster_id=p_cluster for update;
 if not found then raise exception 'HOST_CLUSTER_NOT_FOUND'; end if;
 t=clock_timestamp(); previous_owner=c.owner_node;
 insert into public.launcher_host_nodes(cluster_id,node,last_seen,status) values(p_cluster,p_node,t,p_status)
 on conflict(cluster_id,node) do update set last_seen=t,status=p_status;
 if c.owner_node=p_node and c.owner_session=p_session then
  granted=true;
 elsif c.owner_session is null and c.owner_node=p_node then granted=true;
 elsif p_claim and c.owner_node=p_node and t>c.lease_until+make_interval(secs=>(c.policy->>'failureSeconds')::int) then granted=true;
 elsif p_claim and t>c.lease_until+make_interval(secs=>(c.policy->>'failureSeconds')::int) then
  select * into n from public.launcher_host_nodes where cluster_id=p_cluster and node=p_node;
  eligible=n.snapshot_at is not null and n.snapshot_source=c.owner_node and n.snapshot_epoch=c.epoch
   and n.snapshot_at>=t-make_interval(mins=>(c.policy->>'maxSnapshotMinutes')::int);
  granted=coalesce(eligible and (c.handoff_node=p_node or ((c.policy->>'allowRecovery')::boolean
   and ((c.policy->>'automatic')::boolean or c.requested_node=p_node))),false);
 end if;
 if granted then
  if c.owner_session is distinct from p_session then
   update public.launcher_host_control set owner_node=p_node,owner_session=p_session,epoch=epoch+1,requested_node=null,handoff_node=null where cluster_id=p_cluster;
  end if;
  update public.launcher_host_control set lease_until=t+interval '60 seconds',updated_at=t where cluster_id=p_cluster returning * into c;
  if p_cluster='main' then
   host=case when p_node='vps' then '158.247.246.225' else 'server.fri4666.com' end;
   update public.launcher_releases set manifest=jsonb_set(manifest,'{server,host}',to_jsonb(host),false)
    where active and pack_id in ('bweeep-pokemon-cobblebox-weekday','bweeep-pokemon-cobbleverse') and manifest->'server'->>'host' is distinct from host;
  end if;
 end if;
 return jsonb_build_object('granted',granted,'restoreRequired',granted and previous_owner<>p_node,'serverNow',t,'state',public.launcher_host_state(p_cluster));
end $$;

create or replace function public.launcher_host_release(p_cluster text,p_node text,p_session uuid,p_epoch bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare c public.launcher_host_control; n public.launcher_host_nodes;
begin
 select * into c from public.launcher_host_control where cluster_id=p_cluster for update;
 if c.owner_node<>p_node or c.owner_session is distinct from p_session or c.epoch<>p_epoch then return false; end if;
 if c.requested_node is null or c.requested_node=p_node then raise exception 'HANDOFF_NOT_REQUESTED'; end if;
 select * into n from public.launcher_host_nodes where cluster_id=p_cluster and node=c.requested_node;
 if n.snapshot_epoch is distinct from c.epoch or n.snapshot_source is distinct from p_node or n.snapshot_at is null or n.snapshot_at<clock_timestamp()-interval '60 seconds' then raise exception 'HANDOFF_NOT_READY'; end if;
 update public.launcher_host_control set lease_until=clock_timestamp()-make_interval(secs=>(policy->>'failureSeconds')::int),handoff_node=requested_node,updated_at=clock_timestamp()
 where cluster_id=p_cluster;
 return true;
end $$;

revoke all on function public.launcher_host_state(text),public.launcher_host_admin(uuid,text,jsonb),public.launcher_host_snapshot(text,text,text,bigint,timestamptz,text),public.launcher_host_poll(text,text,uuid,boolean,text),public.launcher_host_release(text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.launcher_host_state(text),public.launcher_host_admin(uuid,text,jsonb),public.launcher_host_snapshot(text,text,text,bigint,timestamptz,text),public.launcher_host_poll(text,text,uuid,boolean,text),public.launcher_host_release(text,text,uuid,bigint) to service_role;
