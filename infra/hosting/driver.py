#!/usr/bin/python3
import os,sys,json,subprocess,pathlib,shutil,fcntl,time
cfg=json.load(open(sys.argv[1]));action=sys.argv[2]
node=cfg['node']; assert node in ('vps','pc')
base=pathlib.Path('/run/bweeep-host-agent');base.mkdir(exist_ok=True)
lock=open(base/'driver.lock','w');fcntl.flock(lock,fcntl.LOCK_EX)
uid=subprocess.check_output(['id','-u','dev'],text=True).strip()
units=['bweeep-cobblebox-weekday','bweeep-cobbleverse-fabric']
gates=['bweeep-gate@'+x+'.service' for x in units]
aux=['bweeep-notice-relay','bweeep-cobbleverse-main-op-online']
games=['cobblebox-weekday-fabric-1.7.42','cobbleverse-fabric-1.7.42']
def user(*args,check=True):
 return subprocess.run(['runuser','-u','dev','--','env','XDG_RUNTIME_DIR=/run/user/'+uid,'systemctl','--user',*args],check=check,stdout=subprocess.DEVNULL)
def nft(s):subprocess.run(['/usr/sbin/nft','-f','-'],input=s,text=True,check=True,stdout=subprocess.DEVNULL)
if action=='init':
 if subprocess.run(['/usr/sbin/nft','list','table','inet','bweeep_lease'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
  nft("""table inet bweeep_lease {
 set ports { type inet_service; flags timeout; timeout 20s; }
 chain input {
  type filter hook input priority -10; policy accept;
  tcp dport {25565,31234} tcp dport @ports return
  tcp dport {25565,31234} drop
 }
}
""")
 for unit in units+aux:
  p=pathlib.Path('/home/dev/.config/systemd/user')/(unit+'.service.d');p.mkdir(exist_ok=True)
  (p/'zzz-host-lease.conf').write_text('[Unit]\nConditionPathExists=/run/bweeep-host-agent/active\n')
 user('daemon-reload')
elif action=='permit':
 auth=json.load(open(base/'authorization.json'))
 role=(base/'role').read_text().strip()
 if auth['until']<time.clock_gettime(time.CLOCK_BOOTTIME) or auth['role']!=role:raise RuntimeError('Port authorization expired or role changed')
 nft('flush set inet bweeep_lease ports\nadd element inet bweeep_lease ports {25565 timeout 20s,31234 timeout 20s}\n')
elif action in ('fence','proxy','activate'):
 nft('flush set inet bweeep_lease ports')
 (base/'role').write_text('fenced')
 (base/'active').unlink(missing_ok=True)
 if node=='pc':pathlib.Path('/home/dev/vultr-migration-20261030/ALLOW_LOCAL_BACKEND').unlink(missing_ok=True)
 user('stop',*gates,*[x+'.service' for x in units+aux])
 if action=='fence':sys.exit()
 for unit in units:
  p=pathlib.Path('/home/dev/.config/systemd/user')/('bweeep-gate@'+unit+'.service.d')
  p.mkdir(exist_ok=True)
  command='/opt/node-v24.18.0/bin/node '
  command+=('/usr/local/lib/bweeep-hosting/proxy.mjs '+node+' /home/dev/servers/bweeep-gate/'+unit+'.json') if action=='proxy' else ('/home/dev/servers/bweeep-gate/scheduled-20261023/server-gate.mjs --config /home/dev/servers/bweeep-gate/'+unit+'.json')
  (p/'zzz-host-role.conf').write_text('[Service]\nExecStart=\nExecStart='+command+'\n')
 if action=='activate':
  state=json.load(open(cfg['stateFile']))
  if state.get('restoreRequired'):
   expected=next((x for x in state['nodes'] if x['node']==node),None)
   if not expected or not expected.get('snapshotId'):raise RuntimeError('Coordinator snapshot is missing')
   snapdir=pathlib.Path(cfg['standbyRoot'])/expected['snapshotId']
   snap=json.load(open(snapdir/'metadata.json'))
   if snap['id']!=expected['snapshotId'] or snap['epoch']!=state['epoch']-1 or snap['source']==node:raise RuntimeError('Snapshot authority mismatch')
   for game in games:
    src=snapdir/'servers'/game;dst=pathlib.Path('/home/dev/servers')/game
    if not (src/'world'/'level.dat').is_file():raise RuntimeError('World snapshot missing')
    if node=='pc':
     retained=pathlib.Path('/home/dev/vultr-migration-20261030/retained-original')/game
     if dst.exists() and not retained.exists():
      retained.parent.mkdir(parents=True,exist_ok=True);dst.rename(retained)
    dst.mkdir(parents=True,exist_ok=True)
    subprocess.run(['rsync','-a','--delete',str(src)+'/',str(dst)+'/'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['chown','-R','dev:dev',str(dst)],check=True)
  state['restoreRequired']=False
  statepath=pathlib.Path(cfg['stateFile']);tmp=statepath.with_suffix('.new');tmp.write_text(json.dumps(state));tmp.replace(statepath)
  (base/'active').touch()
  if node=='pc':pathlib.Path('/home/dev/vultr-migration-20261030/ALLOW_LOCAL_BACKEND').touch()
 (base/'role').write_text('active' if action=='activate' else 'proxy')
 user('daemon-reload');user('start',*gates)
 if action=='activate':user('start',*[x+'.service' for x in aux])
else:raise RuntimeError('Invalid host action')
