package com.bweeep.guard;

import java.lang.instrument.Instrumentation;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Ends the game once it is no longer connected to the selected server, so a
 * player who leaves, is kicked or cannot get in never lands on the title
 * screen. The short wait lets the game log why it disconnected, and a new
 * connection to the same server in that time (a transfer back to it) keeps
 * the game running.
 */
final class LeaveWatch {
    // Players notice anything longer: the game used to close as soon as they left.
    static final long GRACE_MS = 100L;
    private static final long HALT_AFTER_MS = 2_000L;
    private static final long CLIENT_HALT_AFTER_MS = 10_000L;

    /** Connections to the selected server being opened or open. */
    private final AtomicInteger active = new AtomicInteger();
    private final AtomicLong opened = new AtomicLong();
    private final AtomicBoolean exited = new AtomicBoolean();
    private final long graceMs;
    private final Runnable exit;

    LeaveWatch(long graceMs, Runnable exit) {
        this.graceMs = graceMs;
        this.exit = exit;
    }

    static LeaveWatch exitingJvm(final Instrumentation instrumentation) {
        return new LeaveWatch(GRACE_MS, new Runnable() {
            @Override
            public void run() {
                exitJvm(instrumentation);
            }
        });
    }

    void opening() {
        // Counted before active, and read after it, so a timer never misses a new connection.
        opened.incrementAndGet();
        active.incrementAndGet();
    }

    /** A connection to the selected server failed to open, or closed. */
    void ended() {
        if (active.decrementAndGet() > 0) return;
        final long seen = opened.get();
        Thread timer = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(graceMs);
                } catch (InterruptedException ignored) {
                    // Exit now instead.
                }
                if (active.get() == 0 && opened.get() == seen && exited.compareAndSet(false, true)) exit.run();
            }
        }, "Bweeep leave watch");
        timer.setDaemon(true);
        timer.start();
    }

    private static void exitJvm(Instrumentation instrumentation) {
        System.out.println("BWEEP_EXIT_ON_LEAVE");
        if (ClientExit.requestStop(instrumentation)) {
            System.out.println("BWEEP_EXIT_GRACEFUL_REQUESTED");
            startWatchdog(CLIENT_HALT_AFTER_MS);
            return;
        }
        startWatchdog(HALT_AFTER_MS);
        exitFallback();
    }

    private static void startWatchdog(final long timeoutMs) {
        // A shutdown hook that hangs (a busy render thread, a mod) must not keep the game open.
        Thread halt = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(timeoutMs);
                } catch (InterruptedException ignored) {
                    // Halt now instead.
                }
                System.out.println("BWEEP_EXIT_WATCHDOG");
                Runtime.getRuntime().halt(0);
            }
        }, "Bweeep exit watchdog");
        halt.setDaemon(true);
        halt.start();
    }

    private static void exitFallback() {
        try {
            System.exit(0);
        } catch (SecurityException trapped) {
            // Forge 1.8 to 1.12 lets only Minecraft itself exit; its security manager guards nothing else.
            try {
                System.setSecurityManager(null);
                System.exit(0);
            } catch (Throwable ignored) {
                // The watchdog cannot halt either; the player still has the quit button.
            }
        }
    }
}
