package com.fri4666.bweeep.auth;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
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

        if (currentPlayerId == null) {
            if (currentName == null || !currentName.matches("[A-Za-z0-9_]{3,16}")) {
                throw new IOException("Minecraft did not provide a valid profile name for the new player identity.");
            }
            currentPlayerId = offlineUuid(currentName);
        }

        UUID playerId = findPreviousNamePlayer(gameDir, currentPlayerId, currentName, previousGameNames);
        if (playerId == null) playerId = findLegacyOperatorPlayer(gameDir, currentPlayerId, role);
        ensureUnique(identities, accountKey, playerId, identityFile);
        identities.addProperty(accountKey, playerId.toString());
        write(identityFile, identities);
        return playerId;
    }

    private static UUID findPreviousNamePlayer(Path gameDir, UUID currentPlayerId, String currentName,
            List<String> previousGameNames) throws IOException {
        Path playerData = resolvePlayerDataDirectory(gameDir);
        Set<UUID> existingProfiles = new HashSet<>();
        if (currentName != null && currentName.matches("[A-Za-z0-9_]{3,16}")) {
            UUID currentNameId = offlineUuid(currentName);
            if (!currentPlayerId.equals(currentNameId) && Files.isRegularFile(playerData.resolve(currentNameId + ".dat"))) {
                existingProfiles.add(currentNameId);
            }
        }
        for (String name : previousGameNames) {
            if (name == null || !name.matches("[A-Za-z0-9_]{3,16}")) continue;
            UUID candidate = offlineUuid(name);
            if (!candidate.equals(currentPlayerId) && Files.isRegularFile(playerData.resolve(candidate + ".dat"))) {
                existingProfiles.add(candidate);
            }
        }
        if (existingProfiles.size() > 1) {
            throw new IOException("Multiple legacy player files match this launcher account; refusing to merge characters.");
        }
        if (existingProfiles.isEmpty()) {
            return Files.isRegularFile(playerData.resolve(currentPlayerId + ".dat")) ? currentPlayerId : null;
        }
        UUID selected = existingProfiles.iterator().next();
        if (Files.isRegularFile(playerData.resolve(currentPlayerId + ".dat"))) {
            throw new IOException("Both the current and legacy player UUID already have data; refusing to overwrite either character.");
        }
        return selected;
    }

    private static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8));
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

    private static UUID findLegacyOperatorPlayer(Path gameDir, UUID currentPlayerId, String role) throws IOException {
        if (!"admin".equals(role)) return currentPlayerId;
        Path opsFile = gameDir.resolve("ops.json");
        if (!Files.isRegularFile(opsFile)) return currentPlayerId;

        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(Files.readString(opsFile));
        } catch (RuntimeException error) {
            throw new IOException("ops.json is invalid; refusing to guess an existing player identity.", error);
        }
        if (!parsed.isJsonArray()) throw new IOException("ops.json is not an array.");

        Path playerData = resolvePlayerDataDirectory(gameDir);
        Set<UUID> existingOperators = new HashSet<>();
        parsed.getAsJsonArray().forEach(entry -> {
            if (!entry.isJsonObject()) return;
            JsonElement uuid = entry.getAsJsonObject().get("uuid");
            if (uuid == null || !uuid.isJsonPrimitive()) return;
            try {
                UUID candidate = UUID.fromString(uuid.getAsString());
                if (Files.isRegularFile(playerData.resolve(candidate + ".dat"))) existingOperators.add(candidate);
            } catch (IllegalArgumentException ignored) {
                // Ignore malformed rows; they cannot safely identify player data.
            }
        });

        if (existingOperators.size() > 1) {
            throw new IOException("Multiple existing operator characters were found; refusing to guess which one to keep.");
        }
        if (existingOperators.size() == 1) {
            UUID operatorId = existingOperators.iterator().next();
            if (!operatorId.equals(currentPlayerId) && Files.isRegularFile(playerData.resolve(currentPlayerId + ".dat"))) {
                throw new IOException("Both current and operator player files exist; refusing to replace either character.");
            }
            return operatorId;
        }
        return currentPlayerId;
    }

    private static Path resolvePlayerDataDirectory(Path gameDir) throws IOException {
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
        if (!worldDir.startsWith(gameDir)) return gameDir.resolve("world").resolve("playerdata");
        return worldDir.resolve("playerdata");
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
