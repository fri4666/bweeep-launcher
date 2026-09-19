package com.fri4666.bweeepname;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;

final class DisplayNameStore {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Type MAP_TYPE = new TypeToken<Map<String, String>>() {}.getType();
    private final Path file;
    private final Map<String, String> names;

    DisplayNameStore(Path file) {
        this.file = file;
        this.names = load(file);
    }

    synchronized String get(String identityKey) {
        return names.get(identityKey);
    }

    synchronized boolean setOnce(String identityKey, String displayName) throws IOException {
        if (names.containsKey(identityKey)) return false;
        names.put(identityKey, displayName);
        try {
            save();
            return true;
        } catch (IOException error) {
            names.remove(identityKey);
            throw error;
        }
    }

    private static Map<String, String> load(Path file) {
        if (!Files.isRegularFile(file)) return new HashMap<>();
        try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            Map<String, String> loaded = GSON.fromJson(reader, MAP_TYPE);
            return loaded == null ? new HashMap<>() : new HashMap<>(loaded);
        } catch (IOException | RuntimeException ignored) {
            return new HashMap<>();
        }
    }

    private void save() throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        try (Writer writer = Files.newBufferedWriter(temporary, StandardCharsets.UTF_8)) {
            GSON.toJson(names, MAP_TYPE, writer);
        }
        try {
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
