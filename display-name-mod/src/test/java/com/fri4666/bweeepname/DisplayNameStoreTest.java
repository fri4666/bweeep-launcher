package com.fri4666.bweeepname;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DisplayNameStoreTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void persistsAcrossReloadAndRejectsASecondChoice() throws Exception {
        Path file = temporaryDirectory.resolve("bweeep-data/display-names.json");
        String identityKey = "discord:123456789012345678";
        DisplayNameStore first = new DisplayNameStore(file);
        assertTrue(first.setOnce(identityKey, "서오스"));

        DisplayNameStore reloaded = new DisplayNameStore(file);
        assertEquals("서오스", reloaded.get(identityKey));
        assertFalse(reloaded.setOnce(identityKey, "두번째 이름"));
        assertEquals("서오스", new DisplayNameStore(file).get(identityKey));
    }
}
