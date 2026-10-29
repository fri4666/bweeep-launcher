Korea VPS update delivery preparation
====================================
Origin: https://158.247.246.225/releases/
Host: 158.247.246.225 (Vultr ICN, Ubuntu 26.10).
Only /srv/bweeep-updates is a public download root. Never place a world,
credentials, private key, temporary upload or unsigned candidate in that root.

Current implementation:
- New launcher code tries the pinned VPS origin for hash-addressed runtime
  and installer chunks. Existing channel pointers and signed descriptors
  remain in Supabase. A definite VPS 404 uses the old immutable Storage URL.
- Signatures, packed/unpacked hashes, full installer hash and NSIS/UAC
  boundaries remain in the existing updater. TLS and other server failures
  surface as errors. No TLS verification bypass or arbitrary redirect.
- stage-vps-release.mjs verifies a signed runtime manifest and optional
  installer descriptor and writes immutable parts into a PRIVATE directory.
  It neither uploads data nor updates a channel.
- nginx serves those parts as normal static files with Range support.

Before any real cutover:
1. Review/merge the source through a human-approved PR and a separate version
   release. Do not merge the GitHub-delivery PR41 for this VPS rollout.
2. Run the existing exact-version x64/ARM64 and protected/per-user Windows
   installer/update acceptance gates. These have NOT run for this branch.
3. Generate signed release files via the current publisher. Stage both runtime
   and installer parts, using the exact packaged public verification key:
   BWEEP_UPDATE_PUBLIC_KEY_BASE64=<public PEM as base64> node scripts/stage-vps-release.mjs RUNTIME SIGNED-MANIFEST PRIVATE-STAGING INSTALLER SIGNED-INSTALLER-DESCRIPTOR
4. Verify every staged file before publishing it to /srv/bweeep-updates/releases.
   Copy only reviewed eligible release objects. Hash-addressed existing files
   must never be overwritten with different bytes.
5. Fetch every VPS part with trusted HTTPS; verify complete packed/unpacked
   runtime and complete installer hashes against their signed metadata.
6. Publish channel pointers only after eligibility and real Windows validation.
   Existing clients still depend on Storage; no old objects may be deleted.
7. A scoped CI upload credential and automatic publication wiring are still
   required. No deployment key or GitHub secret has been created in this task.
   Do not install the root SSH key in GitHub Actions.
8. The initial browser installer route is still the existing Supabase route.
   No Edge Function or auth/database change was deployed.

TLS:
Owner explicitly approved Let's Encrypt registration/terms in this chat.
IP certificate issued, automatic certbot.timer and nginx deploy hook enabled.
Use certbot renew --dry-run to verify renewal. IP certificates are short-lived.
Certificate private keys must stay on this VPS. Never commit them.

Rollback:
Keep channel pointers unchanged until all gates pass. Revert a published
launcher change through a new PR and validated release, never rewrite main or
published signed bytes. Retained Storage parts support older clients.

Limits:
Free Vultr credit expiry and data-transfer allowance were not inspected.
Sharing one VPS makes game uptime and download availability dependent on the
same host. Real simultaneous player/update load is still untested.

Signed payload mirroring
-----------------------
scripts/mirror-vps-updates.mjs reads the existing public stable/beta channel
manifests and archived installer descriptors, checks their Ed25519 signatures,
then verifies packed SHA-256, decompressed SHA-256 and sizes before atomically
publishing immutable parts under /srv/bweeep-updates. It uses only the public key.
Existing channel pointers and installer approvals are not changed.

bweeep-update-mirror.timer reruns two minutes after the last job finishes.
The release metadata and authentication remain on Supabase. A newly approved
release can briefly use the explicit 404-only legacy bridge until its verified
VPS mirror is complete. Other VPS failures remain visible and do not silently
fall back. Existing installed launchers keep their current source until a
reviewed launcher release includes src/main/update-delivery.ts.

This mirror adds no GitHub deployment credential and requires no paid plan.
Its files are an additional verified copy; it does not delete Storage history.
