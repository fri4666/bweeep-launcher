package com.fri4666.bweeep.notify.core;

import java.util.Objects;

/** One notice ready to show. {@code holdMs} is how long the banner stays fully open. */
public record Notice(NoticeLevel level, String text, int holdMs) {
    public Notice {
        Objects.requireNonNull(level, "level");
        Objects.requireNonNull(text, "text");
        if (holdMs < 0) throw new IllegalArgumentException("holdMs");
    }
}
