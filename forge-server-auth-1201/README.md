# Bweeep Forge 1.20.1 login ticket bridge

Build inside WSL: `./gradlew build --offline --no-daemon`. The output is `build/libs/bweeep-server-auth-1201-0.1.0.jar`.

Install the same JAR in the Forge 1.20.1 client and the matching Forge 1.20.1 server. The channel is mandatory on both sides. The client reads its one-time ticket from `BWEEP_GAME_TICKET`, which must be a 43-character base64url value supplied by the launcher. The server sends a login query and waits for a response from the client. The server consumes that ticket through `consumeGameTicket` with the Microsoft game name before permitting login. An absent mod, absent ticket, duplicate response, non-200 response, malformed identity, timeout, or network error closes the connection. No authentication bypass flag exists.

The production ticket endpoint is fixed to `https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access`. For an isolated test, the server may set `BWEEP_GAME_TICKET_ENDPOINT=http://127.0.0.1:<port>/...` (or `[::1]`). Any other override fails at startup. Never put a secret or ticket in a command line, manifest, or log. The JAR contains no service-role key.

An isolated end-to-end test needs a separate Forge server directory, world, and port. Its mock endpoint should return a successful `consumeGameTicket` result only once for the expected ticket and game name, for example `{"ok":true,"userId":"<UUID>","discordId":"<15-22 digits>","role":"member"}`. Verify three separate connections: no auth JAR is rejected during Forge handshake; auth JAR without a ticket is rejected; auth JAR with a matching ticket is admitted once, then a replay is rejected. Also test that mock HTTP failure rejects. The real production server, world, and port are outside this test.
