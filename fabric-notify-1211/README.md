# Bweeep Notify (Fabric 1.21.1)

Client-only mod that shows a server notice as a banner at the top centre of the
screen: a ding, an icon and a colour for the level, a short slide in from above,
and a closing in which both ends move toward the centre until the banner is
gone. The server needs **no mod**; any server software that can run `tellraw`
(through RCON, a command block or the console) can send a notice.

## Message format

A notice is a vanilla system message with the translate key `bweeep.notice` and
three arguments: level, seconds, text.

```
tellraw @a {"translate":"bweeep.notice","fallback":"[공지] %3$s","with":["warning","8","5분 뒤 재시작합니다"]}
```

| Argument | Meaning |
| --- | --- |
| level | `info`, `success`, `warning` or `urgent`. Anything else shows as `info`. |
| seconds | How long the banner stays fully open, 2 to 30. `0` or anything unreadable means 5. |
| text | Up to 100 characters. Formatting codes (`§x`), control and invisible characters are removed, white space is collapsed, longer text ends with `…`. |

- Players **without** the mod see the `fallback` line in chat: `[공지] 5분 뒤 재시작합니다`.
- With the mod the message is taken out of chat, so a notice is not shown twice.
- Only system messages are read. Players cannot send a system message, so chat
  cannot be used to fake a notice.
- Levels are queued one at a time, more important first. A notice that outranks
  the banner on screen (`urgent` over `info`, and so on) makes it close early.
  The same level and text twice within 1.5 s shows once. At most 8 wait.

Send one from the server host with the helper in the repo root:

```
node scripts/bweeep-notify.mjs <server-unit> <level> "<text>" [--seconds N]          # dry run
node scripts/bweeep-notify.mjs <server-unit> <level> "<text>" [--seconds N] --send   # really sends
```

## Layout

- `core/` has no Minecraft imports (levels, parser, text cleaning, timeline,
  queue, icon shapes) and is covered by JUnit tests. The Forge 1.20.1 build in
  `../forge-notify-1201` reads `core/`, `NoticeMessages`, `BannerRenderer` and
  the sound files from here (nothing is copied) and adds its own entry point,
  events and `NoticeSound`. `NotifyClient` (events) and `NoticeSound` are the
  Fabric-only classes; keep `core/`, `NoticeMessages` and `BannerRenderer` free
  of calls that exist only in Minecraft 1.21, or the Forge build stops compiling.
- Icons are drawn from rectangles in code; the ding is a synthesized original
  tone (`tools/make-notice-sound.py`, needs ffmpeg with libvorbis; without
  ffmpeg keep the committed `notice.ogg`). The sound event is created, not
  registered, so a client-only mod adds nothing to a synced registry.

## Build and test

```
./gradlew test build        # JDK 21; jar in build/libs/
node ../scripts/verify-notify-sender.mjs       # sender checks with a fake RCON server
node ../scripts/verify-notify-banner.mjs       # real game on a virtual display, records and measures the banner
node ../scripts/verify-notify-banner.mjs --no-mod   # the chat fallback without the mod
```

The jar is not wired into the launcher yet: a pack would pin it in the
manifest `files` (path `mods/bweeep-notify.jar`, sha256, https or storage URL).
