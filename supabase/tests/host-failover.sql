begin;
do $test$
declare a jsonb; b jsonb; v uuid=gen_random_uuid(); p uuid=gen_random_uuid(); epoch bigint; result boolean;
begin
 insert into public.launcher_host_control(cluster_id) values('test-failover');
 a=public.launcher_host_poll('test-failover','vps',v,true,'active');
 assert (a->>'granted')::boolean,'Initial VPS claim failed';
 epoch=(a->'state'->>'epoch')::bigint;
 b=public.launcher_host_poll('test-failover','pc',p,true,'standby');
 assert not(b->>'granted')::boolean,'PC stole live lease';
 assert public.launcher_host_snapshot('test-failover','pc','vps',epoch,clock_timestamp(),'snapshot-valid'),'Snapshot rejected';
 update public.launcher_host_control set lease_until=clock_timestamp()-interval '200 seconds' where cluster_id='test-failover';
 b=public.launcher_host_poll('test-failover','pc',p,true,'standby');
 assert not(b->>'granted')::boolean,'Disabled auto failover granted lease';
 update public.launcher_host_control set policy=policy||'{"automatic":true,"allowRecovery":true}'::jsonb where cluster_id='test-failover';
 update public.launcher_host_nodes set snapshot_at=clock_timestamp()-interval '1 day' where cluster_id='test-failover' and node='pc';
 b=public.launcher_host_poll('test-failover','pc',p,true,'standby');
 assert not(b->>'granted')::boolean,'Stale snapshot accepted';
 assert public.launcher_host_snapshot('test-failover','pc','vps',epoch,clock_timestamp(),'snapshot-current');
 b=public.launcher_host_poll('test-failover','pc',p,true,'standby_ready');
 assert (b->>'granted')::boolean,'Fresh standby was denied';
 assert (b->'state'->>'epoch')::bigint>epoch,'Epoch did not advance';
 a=public.launcher_host_poll('test-failover','vps',v,false,'active');
 assert not(a->>'granted')::boolean,'Old VPS owner renewed after takeover';
 a=public.launcher_host_poll('test-failover','pc',gen_random_uuid(),true,'active');
 assert not(a->>'granted')::boolean,'Second PC session stole current lease';
 assert not public.launcher_host_snapshot('test-failover','pc','vps',epoch,clock_timestamp(),'old-snapshot'),'Old snapshot epoch accepted';
 assert not public.launcher_host_release('test-failover','vps',v,epoch),'Old owner released new lease';
 -- A planned handoff is permitted with automatic recovery disabled, after a fresh final snapshot.
 epoch=(b->'state'->>'epoch')::bigint;
 update public.launcher_host_control set requested_node='vps',policy=policy||'{"automatic":false,"allowRecovery":false}'::jsonb where cluster_id='test-failover';
 assert public.launcher_host_snapshot('test-failover','vps','pc',epoch,clock_timestamp(),'final-handoff');
 assert public.launcher_host_release('test-failover','pc',p,epoch),'Planned release rejected';
 a=public.launcher_host_poll('test-failover','vps',v,true,'standby');
 assert (a->>'granted')::boolean and (a->>'restoreRequired')::boolean,'Planned takeover failed';
 b=public.launcher_host_poll('test-failover','pc',p,false,'active');
 assert not(b->>'granted')::boolean,'Released PC renewed after handoff';
 assert not has_function_privilege('anon','public.launcher_host_poll(text,text,uuid,boolean,text)','EXECUTE'),'Anonymous agent RPC allowed';
 assert not has_function_privilege('authenticated','public.launcher_host_admin(uuid,text,jsonb)','EXECUTE'),'Client called privileged admin RPC';
 assert (select relrowsecurity from pg_class where oid='public.launcher_host_control'::regclass),'RLS missing';
 begin
  perform public.launcher_host_admin(gen_random_uuid(),'configure','{}');
  raise exception 'Unauthorized admin accepted';
 exception when others then
  if sqlerrm<>'NOT_ADMIN' then raise; end if;
 end;
end $test$;
do $admin$
declare actor uuid; c public.launcher_host_control; a jsonb; other text;
begin
 select user_id into actor from public.launcher_members where role='admin' limit 1;
 if actor is not null then
  select * into c from public.launcher_host_control where cluster_id='main' for update;
  other=case when c.owner_node='vps' then 'pc' else 'vps' end;
  a=public.launcher_host_admin(actor,'switch',jsonb_build_object('node',other));
  assert a->>'requestedNode'=other,'Manual request missing';
  a=public.launcher_host_admin(actor,'switch',jsonb_build_object('node',c.owner_node));
  assert a->'requestedNode'='null'::jsonb,'Pending switch cancellation failed';
  begin
   perform public.launcher_host_admin(actor,'configure',jsonb_build_object('revision',c.revision,'policy',c.policy));
   raise exception 'Stale configuration accepted';
  exception when others then
   if sqlerrm<>'HOST_POLICY_CHANGED' then raise; end if;
  end;
 end if;
end $admin$;
select 'PASS: live lease, disabled takeover, stale backup, fresh promotion, epoch fencing, duplicate process, planned handoff, permissions and admin checks' as result;
rollback;