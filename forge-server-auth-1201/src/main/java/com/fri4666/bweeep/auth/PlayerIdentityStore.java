package com.fri4666.bweeep.auth;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import net.minecraftforge.fml.loading.FMLPaths;

final class PlayerIdentityStore {
    private static final String FILE_NAME = "bweeep-player-identities.json";

    private PlayerIdentityStore() {}

    static synchronized UUID resolve(UUID accountId, UUID currentPlayerId, String role) throws IOException {
        return resolve(FMLPaths.GAMEDIR.get(), accountId, currentPlayerId, "", List.of(), role);
    }

    static synchronized UUID resolve(Path gameDirectory, UUID accountId, UUID currentPlayerId, String currentName,
            List<String> previousGameNames, String role) throws IOException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        Path identityFile = gameDir.resolve(FILE_NAME);
        JsonObject identities = read(identityFile);
        String accountKey = accountId.toString();
        if (identities.has(accountKey)) {
            UUID saved = parseUuid(identities.get(accountKey), identityFile);
            ensureUnique(identities, accountKey, saved, identityFile);
            return saved;
        }

        // A reusable game name, historical name or operator role cannot prove ownership of old world data.
        UUID playerId = UUID.nameUUIDFromBytes(("BweeepAccount:" + accountKey).getBytes(StandardCharsets.UTF_8));
        ensureUnique(identities, accountKey, playerId, identityFile);
        ensureNoUnmappedPlayerState(gameDir, playerId);
        identities.addProperty(accountKey, playerId.toString());
        write(identityFile, identities);
        return playerId;
    }

    private static JsonObject read(Path identityFile) throws IOException {
        if (!Files.exists(identityFile)) return new JsonObject();
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(identityFile));
            if (!parsed.isJsonObject()) throw new IOException("Bweeep identity file is not an object.");
            return parsed.getAsJsonObject();
        } catch (RuntimeException error) {
            throw new IOException("Bweeep identity file is invalid; refusing to create a new player identity.", error);
        }
    }

    private static void ensureNoUnmappedPlayerState(Path gameDir, UUID playerId) throws IOException {
        Path world = resolveWorldDirectory(gameDir);
        for (String file : List.of("playerdata/" + playerId + ".dat", "playerdata/" + playerId + ".dat_old",
                "stats/" + playerId + ".json", "advancements/" + playerId + ".json")) {
            if (Files.exists(world.resolve(file))) {
                throw new IOException("Unmapped player data already exists for this account UUID; require a reviewed identity mapping.");
            }
        }
        Path opsFile = gameDir.resolve("ops.json");
        if (!Files.isRegularFile(opsFile)) return;

        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(Files.readString(opsFile));
        } catch (RuntimeException error) {
            throw new IOException("ops.json is invalid; refusing to allocate an unreviewed player identity.", error);
        }
        if (!parsed.isJsonArray()) throw new IOException("ops.json is not an array.");

        for (JsonElement entry : parsed.getAsJsonArray()) {
            if (!entry.isJsonObject()) continue;
            JsonElement uuid = entry.getAsJsonObject().get("uuid");
            if (uuid == null || !uuid.isJsonPrimitive()) continue;
            try {
                UUID candidate = UUID.fromString(uuid.getAsString());
                if (candidate.equals(playerId)) {
                    throw new IOException("Unmapped operator UUID already exists; require a reviewed identity mapping.");
                }
            } catch (IllegalArgumentException ignored) {
                // A malformed row cannot match this UUID.
            }
        }
    }

    private static Path resolveWorldDirectory(Path gameDir) throws IOException {
        Path propertiesFile = gameDir.resolve("server.properties");
        String levelName = "world";
        if (Files.isRegularFile(propertiesFile)) {
            java.util.Properties properties = new java.util.Properties();
            try (var input = Files.newInputStream(propertiesFile)) {
                properties.load(input);
            }
            levelName = properties.getProperty("level-name", levelName);
        }
        Path worldDir = gameDir.resolve(levelName).normalize();
        if (!worldDir.startsWith(gameDir)) return gameDir.resolve("world");
        return worldDir;
    }

    private static UUID parseUuid(JsonElement value, Path identityFile) throws IOException {
        try {
            if (value == null || !value.isJsonPrimitive()) throw new IllegalArgumentException();
            return UUID.fromString(value.getAsString());
        } catch (RuntimeException error) {
            throw new IOException("Bweeep identity file contains an invalid UUID: " + identityFile, error);
        }
    }

    private static void ensureUnique(JsonObject identities, String accountKey, UUID playerId, Path identityFile) throws IOException {
        for (var entry : identities.entrySet()) {
            if (entry.getKey().equals(accountKey)) continue;
            if (playerId.equals(parseUuid(entry.getValue(), identityFile))) {
                throw new IOException("Player UUID is already assigned to another launcher account.");
            }
        }
    }

    private static void write(Path identityFile, JsonObject identities) throws IOException {
        Path temporary = identityFile.resolveSibling(identityFile.getFileName() + ".tmp");
        Files.writeString(temporary, identities.toString());
        try {
            Files.move(temporary, identityFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, identityFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
