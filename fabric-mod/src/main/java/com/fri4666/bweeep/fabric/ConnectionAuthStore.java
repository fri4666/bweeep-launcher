package com.fri4666.bweeep.fabric;

import java.util.IdentityHashMap;
import java.util.Map;

/** Configuration state belongs to a physical connection, never to a reusable profile UUID. */
final class ConnectionAuthStore<C, I> {
    private final Map<C, Session<I>> sessions = new IdentityHashMap<>();

    synchronized void begin(C connection) {
        sessions.put(connection, new Session<>());
    }

    synchronized Session<I> claimTicket(C connection) {
        Session<I> session = sessions.get(connection);
        if (session == null || session.stage != Stage.TICKET) return null;
        session.stage = Stage.VERIFYING;
        return session;
    }

    synchronized boolean verified(C connection, Session<I> expected, I identity, boolean needsName) {
        if (!owns(connection, expected, Stage.VERIFYING)) return false;
        expected.identity = identity;
        expected.stage = needsName ? Stage.NAME : Stage.READY;
        return true;
    }

    synchronized Session<I> claimName(C connection) {
        Session<I> session = sessions.get(connection);
        if (session == null || session.stage != Stage.NAME) return null;
        session.stage = Stage.SAVING;
        return session;
    }

    synchronized I identity(C connection, Session<I> expected) {
        return expected != null && sessions.get(connection) == expected ? expected.identity : null;
    }

    synchronized boolean nameSaved(C connection, Session<I> expected, I identity) {
        if (!owns(connection, expected, Stage.SAVING)) return false;
        expected.identity = identity;
        expected.stage = Stage.READY;
        return true;
    }

    synchronized boolean nameFailed(C connection, Session<I> expected) {
        if (!owns(connection, expected, Stage.SAVING)) return false;
        expected.stage = Stage.NAME;
        return true;
    }

    synchronized I takeReady(C connection) {
        Session<I> session = sessions.remove(connection);
        return session != null && session.stage == Stage.READY ? session.identity : null;
    }

    synchronized void close(C connection) {
        sessions.remove(connection);
    }

    synchronized boolean close(C connection, Session<I> expected) {
        return sessions.remove(connection, expected);
    }

    private boolean owns(C connection, Session<I> expected, Stage stage) {
        return expected != null && sessions.get(connection) == expected && expected.stage == stage;
    }

    static final class Session<I> {
        private Stage stage = Stage.TICKET;
        private I identity;
    }

    private enum Stage { TICKET, VERIFYING, NAME, SAVING, READY }
}
