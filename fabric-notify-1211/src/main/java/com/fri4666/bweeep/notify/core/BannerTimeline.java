package com.fri4666.bweeep.notify.core;

/**
 * Life of one banner: it slides in from above, stays open, then closes
 * inward: both ends move to the centre until the width reaches zero.
 */
public final class BannerTimeline {
    public static final int ENTER_MS = 380;
    public static final int EXIT_MS = 420;

    public enum Phase { ENTER, HOLD, EXIT, DONE }

    /**
     * @param slide    0 = fully above the screen, 1 = resting place
     * @param width    share of the full width that is still open (1 = full, 0 = closed)
     * @param alpha    opacity of the whole banner
     * @param finished the banner is gone and the next one may start
     */
    public record Frame(Phase phase, float slide, float width, float alpha, boolean finished) {}

    private BannerTimeline() {}

    public static Frame at(long elapsedMs, int holdMs) {
        long elapsed = Math.max(0L, elapsedMs);
        long exitStart = ENTER_MS + (long) Math.max(0, holdMs);
        if (elapsed < ENTER_MS) {
            float t = elapsed / (float) ENTER_MS;
            return new Frame(Phase.ENTER, Easing.outCubic(t), 1f, Easing.clamp01(t * 1.8f), false);
        }
        if (elapsed < exitStart) return new Frame(Phase.HOLD, 1f, 1f, 1f, false);
        if (elapsed < exitStart + EXIT_MS) {
            float t = (elapsed - exitStart) / (float) EXIT_MS;
            return new Frame(Phase.EXIT, 1f, 1f - Easing.inOutCubic(t), 1f - 0.7f * t * t, false);
        }
        return new Frame(Phase.DONE, 1f, 0f, 0f, true);
    }

    /** Total time from start to the end of the closing, for a given hold. */
    public static long totalMs(int holdMs) {
        return ENTER_MS + (long) Math.max(0, holdMs) + EXIT_MS;
    }
}
