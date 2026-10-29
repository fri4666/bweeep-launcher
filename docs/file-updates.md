# Supabase file updates

## Prepared VPS download origin

The VPS delivery candidate uses `https://158.247.246.225/releases/` for
hash-addressed runtime and installer parts. Signed channel pointers and installer
descriptors still come from Supabase. A definite missing VPS object (404) uses
the same immutable Storage URL so older releases and unpublished candidates
remain compatible. TLS, redirects and other HTTP errors are surfaced. Existing
signature, size and SHA-256 checks remain required.

This does not activate a release or change installed clients. A reviewed
version release, complete VPS mirroring, real Windows installation/update
validation and a scoped CI publisher are still needed before cutover.
`scripts/stage-vps-release.mjs` stages only signature/hash-verified runtime and
optional installer chunks in a private directory; it does not publish channels.
See `infra/vps-updates/README.txt` for the prepared origin, gates and rollback.
Do not merge the alternative GitHub-download PR41 for this VPS rollout.
Do not delete Storage objects still needed by installed clients.


## Release layout

The Windows installer bootstraps shortcuts, uninstall, and the invite URL
protocol. It installs an unpacked Electron app. Writable per-user installations
use an Ed25519-signed file list for later app updates. Supabase Storage serves gzip-compressed, immutable
`blobs/<compressed-sha256>/part-<number>.bin` objects and a small mutable
`channels/<stable|beta>/<arch>.json` pointer. The channel pointer is updated
only after every file is uploaded. The launcher verifies the signature, hashes
local files, downloads and expands changed files, hashes each download, waits for the game
to exit, then starts a separate PowerShell helper to replace files and restart.
Installations under the standard Program Files directories use a full signed
NSIS installer when updating. The launcher verifies an installer descriptor for
the exact update version and architecture, downloads its hash-addressed parts,
and verifies the complete executable. Only the NSIS executable requests Windows
administrator approval; a user-editable file-replacement plan or PowerShell
helper is never elevated. The installer keeps the existing installation path
and uses the normal-user restart supplied by NSIS. Cancelling approval leaves
the launcher open and suppresses automatic retries in that running instance
until the user retries.

Files larger than 5 MiB are stored as numbered parts, so each Supabase object
stays below the Free plan's per-object size limit. The first installer is also
stored in parts. A public `launcher-download` Edge Function verifies the signed
manifest, streams the parts as one `.exe` attachment, and checks the full
SHA-256 hash. Opening its URL starts the browser's normal file download without
an intermediate page.
The Free plan's 150-second Edge Function wall clock limit applies to a full
download, so a slow client may need to retry. Verify the complete streamed
installer on the hosted function before promoting the stable pointer.

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
   manifest before streaming the public installer download.
5. Merge v0.1.40 while the GitHub repository and old releases are still
   accessible. The main workflow builds both the old NSIS bridge and the new
   Supabase file release. It publishes the beta channel for testers; the stable
   channel is held until the manual promotion workflow runs.
6. Install the published v0.1.40 beta, trigger another beta build, and
   verify it updates from Supabase by downloading only changed files, waiting
   for an active game, replacing files, and restarting. Check both writable per-user and protected
   Program Files installation paths before promoting the stable release. Run
   the protected-path check from a normal non-elevated user token; an elevated
   CI helper test is not evidence that this path works.
7. Promote stable after the beta checks pass. Then verify an installed
   v0.1.39 upgrades to v0.1.40 through the still-public GitHub release.
   Confirm the direct Supabase installer download, stable channel, beta channel, and
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
paths protected by UAC. A protected installation folder requires the signed NSIS fallback and Windows
administrator approval. Validate approval, cancellation, unchanged user data,
and normal-user restart before treating a release as ready for private source
hosting. Do not move an existing installation or relax its ACLs as a test.
