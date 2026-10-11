package com.fri4666.bweeep.notify.core;

/** Easing curves on 0..1; every function clamps its input. */
public final class Easing {
    private Easing() {}

    public static float clamp01(float t) {
        return t < 0f ? 0f : Math.min(t, 1f);
    }

    /** Fast start, soft landing. */
    public static float outCubic(float t) {
        float u = 1f - clamp01(t);
        return 1f - u * u * u;
    }

    /** Slow start, fast end. */
    public static float inCubic(float t) {
        float c = clamp01(t);
        return c * c * c;
    }

    /** Soft at both ends. */
    public static float inOutCubic(float t) {
        float c = clamp01(t);
        if (c < 0.5f) return 4f * c * c * c;
        float u = -2f * c + 2f;
        return 1f - u * u * u / 2f;
    }
}
