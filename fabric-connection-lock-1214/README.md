# Bweeep Fabric 1.21.4 connection lock

Client-only bridge for the Fabric 1.21.4 server preset. After joining a server,
any disconnect, including the player's Leave Server action, closes Minecraft.
If automatic connection fails or is cancelled, the disconnect, server list, or
title screen also closes Minecraft before another server can be selected. The
launcher remains open and returns to its idle state when the process exits.

Build with Gradle 9.2.1 using `gradle build` in this directory. The `remapJar`
artifact is packaged in `resources/client-mods` and pinned by SHA-256 in
`src/main/client-feature-mods.ts`. The launcher applies it automatically to
matching server manifests unless `clientFeatures.connectionLock` is explicitly
`false`.
