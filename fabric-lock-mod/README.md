# Bweeep Fabric 26.3 Connection Lock

This source builds the client-only Fabric mod packaged as
`resources/client-mods/bweeep-fabric-lock-26.3-0.1.0.jar`.

It is intentionally separate from `fabric-mod/`: Minecraft 26.3 currently has
Fabric loader/API metadata but no Loom-consumable Mojang or Yarn mappings. The
26.3 client jar is already named, so this tiny mixin mod can be compiled
directly against the Mojang client jar and Mixin annotations.

The mod targets `DisconnectedScreen.init()` and closes the client immediately,
preserving the launcher's connection-lock behavior for the vanilla 26.3 server.
