package com.fri4666.bweeep.auth;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

public final class PlayerIdentityStoreCheck {
    private static final String IDENTITY_FILE = "bweeep-player-identities.json";

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("bweeep-identity-check-");
        try {
            UUID account = UUID.fromString("11111111-1111-4111-8111-111111111111");
            UUID victim = offlineUuid("old_name");
            UUID accountPlayer = accountUuid(account);

            Path current = fixture(root, "current-name");
            Files.writeString(current.resolve("world/playerdata/" + victim + ".dat"), "victim-character");
            UUID currentResult = PlayerIdentityStore.resolve(current, account, victim, "old_name", List.of(), "member");
            require(accountPlayer.equals(currentResult), "an unmapped member adopted another player's current-name UUID");
            require("victim-character".equals(Files.readString(current.resolve("world/playerdata/" + victim + ".dat"))),
                "victim data was changed");

            Path historical = fixture(root, "historical-name");
            Files.writeString(historical.resolve("world/playerdata/" + victim + ".dat"), "victim-character");
            require(accountPlayer.equals(PlayerIdentityStore.resolve(historical, account, offlineUuid("new_name"),
                "new_name", List.of("old_name"), "member")), "a member adopted a historical-name character");

            Path operator = fixture(root, "operator");
            Files.writeString(operator.resolve("world/playerdata/" + victim + ".dat"), "operator-character");
            Files.writeString(operator.resolve("ops.json"), "[{\"uuid\":\"" + victim + "\",\"level\":4}]");
            require(accountPlayer.equals(PlayerIdentityStore.resolve(operator, account, offlineUuid("admin_name"),
                "admin_name", List.of(), "admin")), "an admin automatically adopted an unrelated operator character");

            Path firstLogin = fixture(root, "new-player");
            UUID first = PlayerIdentityStore.resolve(firstLogin, account, null, "fresh_name", List.of(), "member");
            require(accountPlayer.equals(first), "a fresh account did not receive its account-bound UUID");
            require(first.equals(PlayerIdentityStore.resolve(firstLogin, account, null, "renamed_name", List.of("fresh_name"), "member")),
                "a game-name change changed the persistent UUID");
            UUID secondAccount = UUID.fromString("44444444-4444-4444-8444-444444444444");
            require(!first.equals(PlayerIdentityStore.resolve(firstLogin, secondAccount, victim, "fresh_name", List.of("fresh_name"), "member")),
                "different accounts with reusable names received the same UUID");

            Path reviewed = fixture(root, "reviewed-map");
            Files.writeString(reviewed.resolve(IDENTITY_FILE), "{\"" + account + "\":\"" + victim + "\"}");
            Files.writeString(reviewed.resolve("world/playerdata/" + victim + ".dat"), "reviewed-character");
            require(victim.equals(PlayerIdentityStore.resolve(reviewed, account, null, "renamed_name", List.of(), "member")),
                "an existing explicit account mapping was not preserved");
            Files.writeString(reviewed.resolve(IDENTITY_FILE), "{\"" + secondAccount + "\":\"" + accountPlayer + "\"}");
            rejects(() -> PlayerIdentityStore.resolve(reviewed, account, null, "fresh_name", List.of(), "member"),
                "a UUID already mapped to a different account was assigned");
            Files.writeString(reviewed.resolve(IDENTITY_FILE), "{\"" + account + "\":\"" + victim + "\",\"" + secondAccount + "\":\"" + victim + "\"}");
            rejects(() -> PlayerIdentityStore.resolve(reviewed, account, null, "fresh_name", List.of(), "member"),
                "an existing duplicate mapping was accepted");

            for (String path : List.of("playerdata/" + accountPlayer + ".dat", "playerdata/" + accountPlayer + ".dat_old",
                    "stats/" + accountPlayer + ".json", "advancements/" + accountPlayer + ".json")) {
                Path collision = fixture(root, "unmapped-state");
                Files.writeString(collision.resolve("server.properties"), "level-name=custom-world\n");
                Path state = collision.resolve("custom-world").resolve(path);
                Files.createDirectories(state.getParent());
                Files.writeString(state, "unmapped-state");
                rejects(() -> PlayerIdentityStore.resolve(collision, account, null, "fresh_name", List.of(), "member"),
                    "unmapped state at the generated UUID was adopted: " + path);
                require(!Files.exists(collision.resolve(IDENTITY_FILE)), "a refused identity was written to disk");
                require("unmapped-state".equals(Files.readString(state)), "unmapped data was overwritten");
            }

            Path operatorCollision = fixture(root, "unmapped-operator");
            Files.writeString(operatorCollision.resolve("ops.json"), "[{\"uuid\":\"" + accountPlayer + "\",\"level\":4}]");
            rejects(() -> PlayerIdentityStore.resolve(operatorCollision, account, null, "fresh_name", List.of(), "member"),
                "an unmapped operator UUID was adopted without review");

            Path corrupt = fixture(root, "corrupt-map");
            for (String invalid : List.of("{", "[]", "{\"" + account + "\":\"bad-uuid\"}")) {
                Files.writeString(corrupt.resolve(IDENTITY_FILE), invalid);
                rejects(() -> PlayerIdentityStore.resolve(corrupt, account, null, "fresh_name", List.of(), "member"),
                    "a corrupt identity file was replaced");
                require(invalid.equals(Files.readString(corrupt.resolve(IDENTITY_FILE))), "corrupt data was overwritten");
            }

            System.out.println("member-current-name-takeover-rejected=passed");
            System.out.println("member-historical-name-takeover-rejected=passed");
            System.out.println("automatic-operator-adoption-rejected=passed");
            System.out.println("new-account-and-rename-stable-uuid=passed");
            System.out.println("explicit-existing-map-preserved=passed");
            System.out.println("cross-account-and-duplicate-mapping-rejected=passed");
            System.out.println("unmapped-player-stats-advancements-operator-fail-closed=passed");
            System.out.println("corrupt-map-fails-closed=passed");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception error) { throw new RuntimeException(error); }
                });
            }
        }
    }

    private static Path fixture(Path root, String name) throws Exception {
        Path path = Files.createTempDirectory(root, name + "-");
        Files.createDirectories(path.resolve("world/playerdata"));
        return path;
    }

    private static UUID accountUuid(UUID account) {
        return UUID.nameUUIDFromBytes(("BweeepAccount:" + account).getBytes(StandardCharsets.UTF_8));
    }

    private static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8));
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void rejects(Checked action, String message) throws Exception {
        try {
            action.run();
        } catch (java.io.IOException expected) {
            return;
        }
        throw new AssertionError(message);
    }

    private interface Checked { void run() throws Exception; }
}
