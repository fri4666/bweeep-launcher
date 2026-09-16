# Bweeep Bridge companion mod

The launcher installs this NeoForge mod on the client and the same JAR runs on the dedicated server.
It submits a 90-second, one-use game ticket after login; the server consumes that ticket through
Supabase, binds it to the exact Minecraft name, grants OP only for an authenticated Discord admin,
and removes OP again when the player disconnects.

Client-only NeoForge 1.21.1 mod used by the launcher. It closes Minecraft when the private multiplayer session disconnects or fails to connect.

Build with Java 21 and the official NeoForge 1.21.1 ModDevGradle setup, then copy `build/libs/bweeep_client-1.0.0.jar` to `resources/client-mods/`.
