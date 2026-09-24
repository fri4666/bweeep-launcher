# Bweeep Forge 1.20.1 connection lock

Client-only Forge 47.4.0 mod for Minecraft 1.20.1.

The launcher passes the selected server as a JVM system property:
`-Dbweeep.targetServer=host:port`.

A Mixin checks vanilla `ConnectScreen.startConnecting` before its connection thread starts and cancels attempts to any other host and port. Forge client events confirm a login to the selected server, then close Minecraft when that session logs out or the client reaches a disconnected or server-selection screen. The mod prints only the fixed markers `BWEEP_TARGET_JOINED` and `BWEEP_TARGET_LEFT` to stdout; it never prints the server address.

The guard covers vanilla ConnectScreen attempts. A third-party mod that opens sockets without using ConnectScreen is outside this client-side guard, so a server-side launch ticket remains necessary for access control. The exact Society 4.1.5 / FancyMenu behavior must be checked in a running client.
