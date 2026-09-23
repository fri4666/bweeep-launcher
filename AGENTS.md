# Bweeep launcher project instructions

For the current diagnosis and decisions, see [[2026-09-23 - Bweeep dynamic server catalog]] in the Codex Memory vault. This file contains only project-critical safeguards.

- When changing launcher updates, keep release updates automatic after eligibility checks. Do not add a manual update/close choice unless the user requests one. Verify with `node scripts/verify-launcher-update.mjs`.
- When changing launch progress, show the actual installation or launch stage. Show a percentage only when a stage has a known, positive total; never display a fabricated `0/0` or `0%`. Verify both positive-file and empty-file flows with `scripts/capture-preview.mjs`.
- When changing server selection or connection behavior, reject unavailable or mismatched manifests, launch the selected server only, and prevent the bundled public server list from overriding it. Verify the selected manifest, generated server list, and a connection test before claiming the lock works.
- When changing game lifecycle behavior, preserve process exit after leaving the server and restore the launch button after normal or abnormal exit. Verify with `node scripts/verify-game-exit.mjs` and an isolated Minecraft connection test where possible.
- When working on the Tycoon server, distinguish client convenience packs from actual server gameplay files. Confirm the server pack's source and contents before installing it. Do not modify the live server, world, or port as part of launcher tests.
