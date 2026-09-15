# 붸에엡

붸에엡 is a personal Minecraft modpack launcher for friends. It reads a server manifest, compares local files by SHA-256, downloads only missing or changed mods, and prepares a launchable instance folder.

## Current status

- Desktop shell: Electron + React.
- Pack sync: files are SHA-256 verified from the protected Supabase Manifest.
- Default pack: Create Aeronautics on `server.fri4666.com:25565`.
- Account choices: Supabase Auth OAuth with PKCE and the `bwe-e-ep://auth/callback` desktop callback. An invitee can choose Discord or Microsoft.
- Invite gate and protected Manifest delivery: Supabase Edge Function with database-backed access and one-time invite codes. Every approved member can create and copy a `BWEEP-…` code for the next friend.
- Game launch: installs Minecraft 1.21.1, Java 21, and NeoForge 21.1.228 into the selected instance, then starts directly into the server.
- Discord launch: creates a stable offline Minecraft profile derived from the Discord account and display name.
- Microsoft launch: verifies Minecraft: Java Edition ownership through Microsoft, Xbox, XSTS, and Minecraft Services, then launches with the account's actual Minecraft profile name and UUID.
- Account menu: shows the Discord profile, stores a server host/port override, and signs out locally.
- Settings: keeps the install location and sync log, and can reset launcher settings without deleting installed modpack files or the Discord account.
- Launcher updates: fetches optional HTTPS release metadata and shows a download popup when a newer version is published.

## Development

```bash
cd /mnt/e/Projects/bweeep-launcher
npm install
npm run typecheck
npm run dev
```

## Manifest model

Each server exposes a `modpack-manifest.json` with Minecraft version, loader version, server address, and a list of files with URL, size, and SHA-256. The launcher installs the pack into `%APPDATA%/Bweeep/instances/<pack-id>` by default.

## Supabase + Discord setup

1. Create a Supabase project, then link this repository and apply the schema:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy launcher-access
```

2. In Supabase Dashboard, enable the Discord provider under **Authentication > Providers**. Discord's Developer Portal client secret belongs in Supabase only; it must never be placed in the Electron app.

3. To offer Microsoft as an alternative login, register an Azure Entra app that supports both organizational and personal Microsoft accounts. Add `https://YOUR_PROJECT.supabase.co/auth/v1/callback` as its Web redirect URI, then enable Azure (Microsoft) in Supabase Auth with the Azure Client ID and Client Secret. Keep **Allow users without an email** disabled. The launcher requests `email`, `offline_access`, and `XboxLive.signin` when the user selects Microsoft.

4. Add `bwe-e-ep://auth/callback` to Supabase **Authentication > URL Configuration > Redirect URLs** and to the Discord application redirect URLs.

5. For development, create `resources/supabase.local.json` from `resources/supabase.example.json`. The packaged launcher already includes this public Supabase configuration; `bweeep-config/supabase.local.json` next to `Bweeep.exe` can override it when changing projects:

```json
{
  "url": "https://YOUR_PROJECT.supabase.co",
  "publishableKey": "sb_publishable_YOUR_KEY",
  "redirectUri": "bwe-e-ep://auth/callback"
}
```

The publishable key is safe to ship with the launcher. Do not add a Supabase secret key, service-role key, or Discord client secret to any launcher resource file.

## Server authentication mode

The server stays on `online-mode=false` so Discord-derived offline profiles and Microsoft profiles can use the same modpack server. Microsoft users still authenticate with their actual Java account before launch, but the server does not perform Mojang account verification in this mixed mode. Keep the server port restricted to friends and use server-side access controls when it becomes publicly reachable.

## Windows package

Run `npm run package:win` in WSL to create `release-installer/Bweeep-Setup-<version>.exe`. The installer lets each player choose an installation folder and creates Bweeep shortcuts in the Start menu and on the desktop. Use `npm run package:portable` when a ZIP-style portable folder is needed instead.

5. After the first owner signs in, promote that Supabase Auth user to the first launcher admin in the SQL Editor:

```sql
insert into public.launcher_members (user_id, role)
values ('YOUR_SUPABASE_AUTH_USER_UUID', 'admin');
```

The first admin can join through the normal launcher flow. Once a person has redeemed an invite code, that member can create their own limited-use invite codes from the launcher. The Edge Function hashes every code before storage, redeems it atomically, and only returns an active modpack Manifest to members.

## Launcher release updates

The launcher checks `resources/launcher-update.json` during development. In a packaged build, place an override at `bweeep-config/launcher-update.json` next to `Bweeep.exe` so the endpoint can change without rebuilding the app:

```json
{
  "metadataUrl": "https://downloads.example.com/bweeep/latest.json"
}
```

The HTTPS metadata endpoint should return only a public download link and release notes:

```json
{
  "version": "0.1.1",
  "downloadUrl": "https://downloads.example.com/bweeep/Bweeep-win32-x64.zip",
  "notes": ["초대 코드 흐름을 개선했습니다.", "서버 연결 설정을 추가했습니다."]
}
```

The old `discord.local.json` and `access-policy.json` files are only legacy prototype artifacts and are no longer read by the launcher.
