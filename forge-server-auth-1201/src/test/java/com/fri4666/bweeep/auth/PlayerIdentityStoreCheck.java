package com.fri4666.bweeep.auth;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

public final class PlayerIdentityStoreCheck {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("bweeep-identity-check-");
        try {
            UUID account = UUID.fromString("11111111-1111-4111-8111-111111111111");
            UUID legacyPlayer = offlineUuid("old_name");
            UUID renamedOfflinePlayer = offlineUuid("new_name");
            Path playerData = root.resolve("world/playerdata");
            Files.createDirectories(playerData);
            Files.writeString(root.resolve("server.properties"), "level-name=world\n");
            Files.writeString(root.resolve("ops.json"), "[{\"uuid\":\"" + legacyPlayer + "\",\"name\":\"old_name\",\"level\":4}]");
            Files.writeString(playerData.resolve(legacyPlayer + ".dat"), "existing-character");

            UUID firstLogin = PlayerIdentityStore.resolve(root, account, renamedOfflinePlayer, "new_name", java.util.List.of("old_name"), "admin");
            if (!legacyPlayer.equals(firstLogin)) throw new AssertionError("legacy operator character was not adopted");
            UUID afterRename = PlayerIdentityStore.resolve(root, account, offlineUuid("another_name"), "another_name", java.util.List.of("new_name", "old_name"), "admin");
            if (!legacyPlayer.equals(afterRename)) throw new AssertionError("rename changed the persistent player UUID");

            Path firstLoginRoot = Files.createTempDirectory(root, "first-login-");
            UUID firstLoginAccount = UUID.randomUUID();
            UUID firstLoginId = PlayerIdentityStore.resolve(firstLoginRoot, firstLoginAccount, null, "fresh_name", java.util.List.of(), "member");
            if (!offlineUuid("fresh_name").equals(firstLoginId)) throw new AssertionError("null offline profile UUID was not derived from its name");
            UUID renamedFirstLoginId = PlayerIdentityStore.resolve(firstLoginRoot, firstLoginAccount, null, "renamed_name", java.util.List.of("fresh_name"), "member");
            if (!firstLoginId.equals(renamedFirstLoginId)) throw new AssertionError("a first-login name change changed the persistent player UUID");

            UUID secondAccount = UUID.fromString("44444444-4444-4444-8444-444444444444");
            try {
                PlayerIdentityStore.resolve(root, secondAccount, legacyPlayer, "old_name", java.util.List.of(), "member");
                throw new AssertionError("duplicate player UUID assignment was accepted");
            } catch (java.io.IOException expected) {
                // One server UUID cannot belong to two launcher accounts.
            }

            Path collisionRoot = Files.createTempDirectory(root, "collision-");
            Path collisionData = collisionRoot.resolve("world/playerdata");
            Files.createDirectories(collisionData);
            Files.writeString(collisionData.resolve(legacyPlayer + ".dat"), "legacy-character");
            Files.writeString(collisionData.resolve(renamedOfflinePlayer + ".dat"), "new-character");
            try {
                PlayerIdentityStore.resolve(collisionRoot, UUID.randomUUID(), renamedOfflinePlayer, "new_name", java.util.List.of("old_name"), "member");
                throw new AssertionError("conflicting old and new player files were merged");
            } catch (java.io.IOException expected) {
                // Require manual recovery when both characters already have files.
            }

            Path corruptRoot = Files.createTempDirectory(root, "corrupt-");
            Files.writeString(corruptRoot.resolve("bweeep-player-identities.json"), "{");
            try {
                PlayerIdentityStore.resolve(corruptRoot, UUID.randomUUID(), UUID.randomUUID(), "member", java.util.List.of(), "member");
                throw new AssertionError("corrupt identity data was silently replaced");
            } catch (java.io.IOException expected) {
                // Refuse login rather than silently allocating a new identity.
            }

            System.out.println("legacy-character-adoption=passed");
            System.out.println("renamed-profile-stable-uuid=passed");
            System.out.println("null-offline-profile-uuid=passed");
            System.out.println("first-login-rename-stable-uuid=passed");
            System.out.println("cross-account-collision-rejected=passed");
            System.out.println("two-existing-characters-fail-closed=passed");
            System.out.println("corrupt-map-fails-closed=passed");
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception error) { throw new RuntimeException(error); }
                });
            }
        }
    }

    private static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
