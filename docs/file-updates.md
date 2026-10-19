# Supabase file updates

## Release layout

The Windows installer remains a one-time bootstrap for shortcuts, uninstall,
and the invite URL protocol. It installs an unpacked Electron app. Later app
updates use an Ed25519-signed file list. Supabase Storage serves gzip-compressed, immutable
`blobs/<compressed-sha256>/part-<number>.bin` objects and a small mutable
`channels/<stable|beta>/<arch>.json` pointer. The channel pointer is updated
only after every file is uploaded. The launcher verifies the signature, hashes
local files, downloads and expands changed files, hashes each download, waits for the game
to exit, then starts a separate PowerShell helper to replace files and restart.
Files larger than 5 MiB are stored as numbered parts, so each Supabase object
stays below the Free plan's per-object size limit. The first installer is also
stored in parts. A public `launcher-download` Edge Function serves a download
page that verifies its signed manifest, joins the parts in the browser, checks
the full SHA-256 hash, and downloads the NSIS installer once.

The current Supabase organization is on the Free plan, which includes 1 GB of
file storage. Compression and content-addressed reuse reduce storage, but
retaining old installers and runtime versions indefinitely will exceed that
quota. Check usage before each release and establish a reviewed retention plan
before removing objects still referenced by installed clients.

The existing NSIS uninstall file is outside the update manifest and remains
installed. The helper keeps replaced files in a backup directory and restores
them if a replacement or restart command fails.

The Storage bucket is public for reads because update checks must work before
login. Write access uses the project secret API key only in CI. Never put it
in the desktop app. The private source repository still produces binaries
users can inspect.

## Prepare the transition

1. Apply `supabase/migrations/20261019000000_add_launcher_update_bucket.sql` to
   the existing Bweeep project. Confirm the new bucket is public and the
   `bweeep-modpacks` bucket stays private.
2. Generate one Ed25519 key pair in a secure environment. Put the **base64 of
   its PEM public key** in GitHub Actions secret
   `BWEEP_UPDATE_PUBLIC_KEY_BASE64`; put the **base64 of its PEM private key**
   in `BWEEP_UPDATE_SIGNING_KEY_BASE64`. Keep the private key out of Git.
3. Add a Supabase secret API key as GitHub Actions secret
   `SUPABASE_SECRET_KEY`. Limit who can edit release workflows or trigger
   the promotion workflow, because this key can write to the project.
4. The public verification key is embedded in `launcher-download`. Deploy it
   with JWT verification disabled. The function verifies the signed installer
   manifest before serving the public download page.
5. Merge v0.1.40 while the GitHub repository and old releases are still
   accessible. The main workflow builds both the old NSIS bridge and the new
   Supabase file release. It publishes the beta channel for testers; the stable
   channel is held until the manual promotion workflow runs.
6. Install the published v0.1.40 beta, trigger another beta build, and
   verify it updates from Supabase by downloading only changed files, waiting
   for an active game, replacing files, and restarting. Check protected
   Windows install paths before promoting the stable release.
7. Promote stable after the beta checks pass. Then verify an installed
   v0.1.39 upgrades to v0.1.40 through the still-public GitHub release.
   Confirm the Supabase download page, stable channel, beta channel, and
   patch notes work without GitHub authentication. Keep the public GitHub
   release available for a migration window before making the repository
   private. Clients that missed v0.1.40 will then need the Supabase installer.

The existing GitHub release workflow may continue to create private releases
for build records after the repository is private. The new launcher does not
use those assets for update downloads.

## Build and verification

`npm run verify:file-update` checks manifest signing, path validation, channel
selection, and tampering. The Windows release job builds the NSIS installer
and `win-unpacked` tree, signs a manifest over every final file, and uploads
the tree to Supabase. `build/after-pack.cjs` writes the current package path
list for removal of obsolete app files on the next update. Windows packaging
requires `BWEEP_UPDATE_PUBLIC_KEY_BASE64`, and release publishing requires
the signing and Supabase credentials above.

Validate on an actual Windows install before promotion, including install
paths protected by UAC. A protected installation folder may need an elevated
helper or a one-time move to the per-user install path.
