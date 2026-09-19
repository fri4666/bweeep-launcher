package com.fri4666.bweeep.fabric;

import java.util.regex.Pattern;

final class DisplayNameRules {
    private static final Pattern ALLOWED = Pattern.compile("[\\p{L}\\p{N}_ ]+");

    private DisplayNameRules() {}

    static String normalize(String raw) {
        if (raw == null) return null;
        String normalized = raw.strip().replaceAll(" +", " ");
        int length = normalized.codePointCount(0, normalized.length());
        return length >= 2 && length <= 16 && ALLOWED.matcher(normalized).matches()
            ? normalized
            : null;
    }
}
