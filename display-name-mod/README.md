# Bweeep Display Name

Standalone NeoForge 1.21.1 client/server mod for one-time server display names.

- Players without a saved name receive one name token after joining.
- Using the token opens a client UI and submits one validated display name.
- A successful submission consumes all remaining tokens and cannot be repeated.
- Names are stored by the Discord ID authenticated by Bweeep Bridge in `bweeep-data/display-names.json` under the server root, outside the world and mod directories. This remains stable even when the offline Minecraft name and UUID change.

This project is intentionally not copied into the live server or launcher manifest until isolated tests pass and deployment is explicitly approved.
