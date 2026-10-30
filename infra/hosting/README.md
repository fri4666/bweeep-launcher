# VPS / PC hosting

The Korea VPS is preferred. The PC can take over using its most recent complete world snapshot. Supabase stores only policy, leases and snapshot metadata; no world archive is uploaded by this controller. Existing cloud-backup preparation remains disabled.

## Runtime

Root systemd service bweeep-host-agent runs on both machines. Install the runtime files under /usr/local/lib/bweeep-hosting and the root-only configuration at /etc/bweeep-host-agent.json. The service-role credentials remain in the existing private notice-relay environment file and are never sent to the launcher.

Both nodes poll the database every five seconds. A database row lock grants one owner/session/epoch a 60-second lease. Notice relay and OP monitoring run only on the active host. Each machine's nftables input rule permits the game ports for only 20 seconds after a fresh grant; the userspace watchdog also stops its gates and backends after 12 seconds without renewal. Takeover waits until lease expiry plus the configured failure interval. An isolated or suspended agent cannot leave its game ports permanently open.

The PC pulls complete snapshots into root-only ext4 storage under /var/lib/bweeep-host-agent/standby. RCON save-off / save-all flush brackets copies; a separate timer restores save-on after a failed job. New snapshots are committed under unique IDs before the database advertises them. Incremental snapshots hard-link unchanged files to the preceding immutable snapshot. The active game directory is an independent copy, never a hard link to a backup.

Copies stop before starting when less than 20 GiB is free on the destination. Only the newest complete, coordinator-acknowledged snapshot is retained on each destination. Install bweeep-snapshot-prune.service alongside the host agent; it is started after a successful capture, without a timer. Cleanup runs at low CPU/I/O priority separately from copying. The preceding acknowledged copy is preserved until its replacement is accepted; newer in-flight copies, unexpected paths and pre-migration original worlds are never pruned. Failed copies therefore do not remove the last usable backup.

An automatic takeover requires a complete snapshot from the current owner and epoch, within the configured age limit. An old or absent snapshot blocks takeover. A planned switch first fences the old owner, captures a final complete snapshot and then releases ownership. Restoring a large world can take several minutes. An interrupted activation retains its restore-required marker for the next attempt.

Changing the preferred node in the admin panel requests a planned switch. Recovery of the preferred node alone does not steal a running secondary's lease; use the switch control to synchronize back. Both old public addresses proxy to the active host while both machines are reachable. If a VPS is deleted, clients need to reconnect using the refreshed launcher catalog.

## PC availability

The PC must be on, Windows must have signed in, WSL must remain running, and the existing game-port forwarding must work. The user Startup file Bweeep Server Standby.vbs launches a hidden WSL sleep process under a nonblocking lock to keep the distribution available. This does not enable unattended operation before Windows sign-in and does not bypass sleep or power-off.

The pre-migration PC directories are retained at /home/dev/vultr-migration-20261030/retained-original. E: restic data from the interrupted earlier backup has no completed snapshot and is not a recovery source. The separate cloud-upload timer is disabled pending storage/billing choice.

## Validation and recovery

Run node scripts/verify-snapshot-retention.mjs, node scripts/verify-host-agent.mjs, node --experimental-transform-types scripts/verify-hosting-admin.mjs and the SQL transaction in supabase/tests/host-failover.sql. The SQL test uses an isolated cluster and rolls back. BWEEP_PREVIEW_HOSTING=true node scripts/capture-preview.mjs checks the management UI against fixtures. probe-status.py HOST PORT checks Minecraft status without joining.

Before a manual recovery, inspect launcher_host_state, both agents, snapshot metadata and current players. Select one authoritative world first; never simply start both original services. Remove only the named zzz-host-role.conf and zzz-host-lease.conf drop-ins if retiring this controller, and restore the earlier migration guards/proxy configuration consistently with the chosen authority. Disabling the root service fences its machine by design. Database/Edge rollback alone does not restore a world or switch authority.

No Windows launcher release is published by these files. The management panel and updater origin require the normal reviewed release process before they appear in the installed launcher.
