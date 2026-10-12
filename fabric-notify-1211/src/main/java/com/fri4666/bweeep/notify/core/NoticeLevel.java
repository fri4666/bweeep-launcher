package com.fri4666.bweeep.notify.core;

import java.util.Locale;
import java.util.Optional;

/** Importance of a notice: decides its colour, icon, ding pitch and queue order. */
public enum NoticeLevel {
    INFO("info", 0, 0xFF4DA3FF, 0xF0152638, 1.00f),
    SUCCESS("success", 1, 0xFF4ADE80, 0xF0123022, 1.25f),
    WARNING("warning", 2, 0xFFFBBF24, 0xF0382B0C, 0.90f),
    URGENT("urgent", 3, 0xFFF87171, 0xF0401414, 0.72f);

    private final String wireName;
    private final int priority;
    private final int accent;
    private final int background;
    private final float pitch;

    NoticeLevel(String wireName, int priority, int accent, int background, float pitch) {
        this.wireName = wireName;
        this.priority = priority;
        this.accent = accent;
        this.background = background;
        this.pitch = pitch;
    }

    /** The name a server puts in the message. */
    public String wireName() {
        return wireName;
    }

    /** Higher shows first and may cut a lower notice short. */
    public int priority() {
        return priority;
    }

    /** ARGB colour of the border and the icon. */
    public int accent() {
        return accent;
    }

    /** ARGB colour of the banner body. */
    public int background() {
        return background;
    }

    /** Pitch of the ding. */
    public float pitch() {
        return pitch;
    }

    /** Exact wire names only. */
    public static Optional<NoticeLevel> fromWireName(String name) {
        if (name == null) return Optional.empty();
        String normalized = name.trim().toLowerCase(Locale.ROOT);
        for (NoticeLevel level : values()) {
            if (level.wireName.equals(normalized)) return Optional.of(level);
        }
        return Optional.empty();
    }

    /** A message from a server must never be dropped for a typo in its level: unknown names show as info. */
    public static NoticeLevel lenient(String name) {
        return fromWireName(name).orElse(INFO);
    }
}
