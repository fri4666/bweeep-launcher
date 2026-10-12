package com.fri4666.bweeep.notify.core;

import java.util.List;
import java.util.Optional;

/**
 * Reads the system message a server sends for a notice:
 * <pre>
 * {"translate":"bweeep.notice","fallback":"[공지] %3$s","with":["&lt;level&gt;","&lt;seconds&gt;","&lt;text&gt;"]}
 * </pre>
 * {@code level} is info, success, warning or urgent; {@code seconds} is how
 * long the banner stays open (0 or anything unreadable means the default).
 */
public final class NoticeParser {
    public static final String KEY = "bweeep.notice";
    public static final int DEFAULT_HOLD_MS = 5_000;
    public static final int MIN_HOLD_MS = 2_000;
    public static final int MAX_HOLD_MS = 30_000;

    private NoticeParser() {}

    public static Optional<Notice> parse(String key, List<String> args) {
        if (!KEY.equals(key) || args == null || args.size() < 3) return Optional.empty();
        String text = NoticeText.sanitize(args.get(2), NoticeText.MAX_CODE_POINTS);
        if (text.isEmpty()) return Optional.empty();
        return Optional.of(new Notice(NoticeLevel.lenient(args.get(0)), text, holdMs(args.get(1))));
    }

    static int holdMs(String seconds) {
        if (seconds == null) return DEFAULT_HOLD_MS;
        double value;
        try {
            value = Double.parseDouble(seconds.trim());
        } catch (NumberFormatException error) {
            return DEFAULT_HOLD_MS;
        }
        if (!(value > 0) || Double.isInfinite(value)) return DEFAULT_HOLD_MS;
        long ms = Math.round(value * 1000.0);
        return (int) Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, ms));
    }
}
