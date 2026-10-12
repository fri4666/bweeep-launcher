package com.fri4666.bweeep.notify.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Queue and state of the banner. One notice shows at a time; the rest wait,
 * the more important ones first. A notice that outranks the one on screen cuts
 * it short. All times are caller-supplied milliseconds, so it needs no clock.
 */
public final class NoticeController {
    public static final int MAX_PENDING = 8;
    public static final long GAP_MS = 120;
    public static final long DUPLICATE_WINDOW_MS = 1_500;

    /**
     * @param started true on the first frame of this notice (play the ding once)
     */
    public record Presented(Notice notice, BannerTimeline.Frame frame, boolean started) {}

    private final List<Notice> pending = new ArrayList<>();
    private Notice active;
    private long activeStart;
    private int activeHold;
    private boolean startReported;
    private long gapUntil = Long.MIN_VALUE;
    private String lastKey;
    private long lastAt = Long.MIN_VALUE;

    /** Returns false when the notice was dropped (a repeat, or the queue is full of more important ones). */
    public synchronized boolean offer(Notice notice, long nowMs) {
        String key = notice.level().wireName() + "|" + notice.text();
        boolean repeat = key.equals(lastKey) && nowMs - lastAt < DUPLICATE_WINDOW_MS;
        lastKey = key;
        lastAt = nowMs;
        if (repeat) return false;

        if (pending.size() >= MAX_PENDING) {
            Notice last = pending.get(pending.size() - 1);
            if (last.level().priority() > notice.level().priority()) return false;
            pending.remove(pending.size() - 1);
        }
        int index = pending.size();
        for (int i = 0; i < pending.size(); i++) {
            if (pending.get(i).level().priority() < notice.level().priority()) {
                index = i;
                break;
            }
        }
        pending.add(index, notice);
        if (active != null && notice.level().priority() > active.level().priority()) cutShort(nowMs);
        return true;
    }

    /** Advances to {@code nowMs}; empty when nothing is on screen. */
    public synchronized Optional<Presented> tick(long nowMs) {
        for (int round = 0; round < 2; round++) {
            if (active == null) {
                if (pending.isEmpty() || nowMs < gapUntil) return Optional.empty();
                active = pending.remove(0);
                activeStart = nowMs;
                activeHold = active.holdMs();
                startReported = false;
            }
            BannerTimeline.Frame frame = BannerTimeline.at(nowMs - activeStart, activeHold);
            if (frame.finished()) {
                active = null;
                gapUntil = nowMs + GAP_MS;
                continue;
            }
            boolean started = !startReported;
            startReported = true;
            return Optional.of(new Presented(active, frame, started));
        }
        return Optional.empty();
    }

    public synchronized int pendingCount() {
        return pending.size();
    }

    /** Starts the closing right after the opening instead of waiting out the hold. */
    private void cutShort(long nowMs) {
        long sinceOpened = Math.max(0L, nowMs - activeStart - BannerTimeline.ENTER_MS);
        activeHold = (int) Math.min(activeHold, sinceOpened);
    }
}
