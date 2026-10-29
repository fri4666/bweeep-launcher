#!/usr/bin/python3
import sys,json,pathlib,os
meta=json.load(sys.stdin)
assert meta['source']=='pc' and isinstance(meta['epoch'],int)
assert isinstance(meta['id'],str) and meta['id'].startswith('snap-') and all(c.isalnum() or c=='-' for c in meta['id'])
root=pathlib.Path('/var/lib/bweeep-host-agent/standby')
incoming=root/'incoming'
assert (incoming/'servers'/'cobblebox-weekday-fabric-1.7.42'/'world'/'level.dat').is_file()
(incoming/'metadata.json').write_text(json.dumps(meta))
target=root/meta['id'];incoming.rename(target)
tmp=root/'latest-new';tmp.unlink(missing_ok=True);tmp.symlink_to(target);os.replace(tmp,root/'latest')
print('SNAPSHOT_INSTALLED')
