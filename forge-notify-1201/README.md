# Bweeep Notify (Forge 1.20.1)

The Forge 1.20.1 build of the notice banner for the Sunlit Valley pack
(Forge 47.4.0). It shows the same banner as the Fabric 1.21.1 mod
(`../fabric-notify-1211`): a ding, a level icon and colour, a slide in from
above, and a closing in which both ends move toward the centre. The message
format, levels, the sender script and the chat fallback are described in that
README. The server needs **no mod**.

## Layout

Nothing is copied from the Fabric module; `build.gradle` reads these files from
`../fabric-notify-1211/src`:

- `core/` (Minecraft-free: levels, parser, text cleaning, timeline, queue, icons)
  and its JUnit tests. Both modules run the same 35 tests.
- `BannerRenderer` and `NoticeMessages`. They only use calls that Minecraft
  1.20.1 and 1.21.1 share (`GuiGraphics`, `Font`, `TranslatableContents`).
- `assets/bweeep_notify/sounds.json` and `sounds/notice.ogg` (the ding).

What is written for Forge is in `src/main/java/com/fri4666/bweeep/notify/`:

| File | Job |
| --- | --- |
| `BweeepNotifyMod` | `@Mod` entry. Does nothing on a dedicated server. |
| `ForgeNotifyClient` | `ClientChatReceivedEvent.System` (system messages only, never player chat) takes the notice out of the chat; `RegisterGuiOverlaysEvent` draws the banner on the HUD, `ScreenEvent.Render.Post` repeats it above an open screen. |
| `ForgeNoticeSound` | The ding. The sound event is created, not registered, so the mod adds nothing to a synced registry. |

`mods.toml` sets `displayTest="IGNORE_SERVER_VERSION"` and client-side
dependencies, so a server without the mod accepts the client and the server
never asks for it.

## Build and test

```
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew build   # JDK 17; jar in build/libs/
node ../scripts/verify-notify-banner.mjs --forge               # real Forge client on a virtual display against a mod-less Forge server
node ../scripts/verify-notify-banner.mjs --forge --no-mod      # the chat fallback without the mod
```

`--forge` uses its own test ports (25594/25595) and display (`:152`) and files
under `~/.cache/bweeep-notify-e2e/run-forge`; it never touches a production
server, port or world.

Jar: `build/libs/bweeep-notify-forge-1.20.1-0.1.0.jar`

sha256 of the jar built on 2026-10-12 (34,922 bytes), the one the E2E run used:
`dce2467afd7b47de6ddba16cc44545871b0d9e15634f1965c4d285ca39847251`.
The hash changes with every rebuild (jar timestamps), so pin the file you
actually upload, not this value.

Verified: 35 core JUnit tests; real Forge 47.4.0 client against a mod-less Forge
server, 23 banner checks plus the chat fallback without the mod; the jar loads
and stays inert on a dedicated Forge server. Not verified: the sound by ear (the
test client has a silent audio device; only "the ding was played and resolves"
is checked), a real Sunlit pack with its other mods, and a Windows client.

Like the Fabric jar it is not wired into the launcher yet: a pack would pin it in
the manifest `files` (path `mods/bweeep-notify.jar`, sha256, https or storage URL).
