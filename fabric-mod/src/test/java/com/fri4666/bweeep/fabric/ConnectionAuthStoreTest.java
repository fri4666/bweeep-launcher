package com.fri4666.bweeep.fabric;

import static org.junit.jupiter.api.Assertions.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class ConnectionAuthStoreTest {
    private record Connection(UUID profile) {}

    @Test
    void aNewConnectionWithTheSameProfileCannotUseAnOldIdentityOrNameSession() {
        var store = new ConnectionAuthStore<Connection, String>();
        UUID profile = UUID.randomUUID();
        var victim = new Connection(profile);
        var replacement = new Connection(profile);
        store.begin(victim);
        var old = store.claimTicket(victim);
        assertTrue(store.verified(victim, old, "victim-session", true));
        store.close(victim);
        store.begin(replacement);
        assertNull(store.claimName(replacement));
        assertNull(store.takeReady(replacement));
        assertFalse(store.nameSaved(replacement, old, "victim-session"));
    }

    @Test
    void aDisconnectedTicketCallbackCannotRepopulateOrConsumeAReplacementSession() {
        var store = new ConnectionAuthStore<Connection, String>();
        UUID profile = UUID.randomUUID();
        var victim = new Connection(profile);
        var replacement = new Connection(profile);
        store.begin(victim);
        var pending = store.claimTicket(victim);
        store.close(victim);
        store.begin(replacement);
        var fresh = store.claimTicket(replacement);
        assertFalse(store.verified(victim, pending, "admin", false));
        assertFalse(store.verified(replacement, pending, "admin", false));
        assertTrue(store.verified(replacement, fresh, "member", false));
        assertEquals("member", store.takeReady(replacement));
        assertNull(store.takeReady(victim));
    }

    @Test
    void oldNameSaveCannotCompleteARepeatedConfigurationOnTheSameConnection() {
        var store = new ConnectionAuthStore<Connection, String>();
        var connection = new Connection(UUID.randomUUID());
        store.begin(connection);
        var old = store.claimTicket(connection);
        assertTrue(store.verified(connection, old, "old", true));
        assertSame(old, store.claimName(connection));
        store.begin(connection);
        var fresh = store.claimTicket(connection);
        assertFalse(store.nameSaved(connection, old, "stale-name"));
        assertFalse(store.nameFailed(connection, old));
        assertFalse(store.close(connection, old));
        assertTrue(store.verified(connection, fresh, "fresh", false));
        assertEquals("fresh", store.takeReady(connection));
    }

    @Test
    void authenticationAndTaskCompletionAreOneUseAndNameSaveCanRetry() {
        var store = new ConnectionAuthStore<Connection, String>();
        var connection = new Connection(UUID.randomUUID());
        store.begin(connection);
        assertNull(store.claimName(connection));
        var pending = store.claimTicket(connection);
        assertNull(store.claimTicket(connection));
        assertTrue(store.verified(connection, pending, "account", true));
        assertSame(pending, store.claimName(connection));
        assertNull(store.claimName(connection));
        assertTrue(store.nameFailed(connection, pending));
        assertSame(pending, store.claimName(connection));
        assertEquals("account", store.identity(connection, pending));
        assertTrue(store.nameSaved(connection, pending, "account-with-name"));
        assertFalse(store.nameSaved(connection, pending, "duplicate"));
        assertNull(store.claimName(connection));
        assertEquals("account-with-name", store.takeReady(connection));
        assertNull(store.takeReady(connection));
    }

    @Test
    void unfinishedConfigurationCannotJoinAndClosedNameSavesCannotRestoreIt() {
        var store = new ConnectionAuthStore<Connection, String>();
        var connection = new Connection(UUID.randomUUID());
        store.begin(connection);
        var pending = store.claimTicket(connection);
        assertTrue(store.verified(connection, pending, "account", true));
        assertNull(store.takeReady(connection));
        assertNull(store.claimName(connection));
        assertFalse(store.nameSaved(connection, pending, "account-with-name"));
        store.begin(connection);
        var next = store.claimTicket(connection);
        assertTrue(store.verified(connection, next, "account", true));
        assertSame(next, store.claimName(connection));
        store.close(connection);
        assertFalse(store.nameSaved(connection, next, "account-with-name"));
        assertNull(store.takeReady(connection));
    }
}
