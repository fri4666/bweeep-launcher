package com.fri4666.bweeep.notify.core;

/** Cleans the text of a notice before it is drawn. */
public final class NoticeText {
    public static final int MAX_CODE_POINTS = 100;
    private static final String ELLIPSIS = "…";

    private NoticeText() {}

    /**
     * Removes formatting codes, control and invisible characters (which could
     * hide or reorder text), collapses white space and cuts the result to
     * {@code maxCodePoints}, ending with an ellipsis when it was cut.
     */
    public static String sanitize(String raw, int maxCodePoints) {
        if (raw == null) return "";
        StringBuilder out = new StringBuilder(raw.length());
        boolean pendingSpace = false;
        int i = 0;
        while (i < raw.length()) {
            int cp = raw.codePointAt(i);
            i += Character.charCount(cp);
            if (cp == '§') {
                // A formatting code is the section sign plus the character after it.
                if (i < raw.length()) i += Character.charCount(raw.codePointAt(i));
                continue;
            }
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp) || cp == '\t' || cp == '\n' || cp == '\r') {
                pendingSpace = out.length() > 0;
                continue;
            }
            int type = Character.getType(cp);
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.UNASSIGNED
                    || type == Character.SURROGATE || type == Character.PRIVATE_USE
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) {
                continue;
            }
            if (pendingSpace) {
                out.append(' ');
                pendingSpace = false;
            }
            out.appendCodePoint(cp);
        }
        String cleaned = out.toString();
        int count = cleaned.codePointCount(0, cleaned.length());
        if (count <= maxCodePoints) return cleaned;
        int end = cleaned.offsetByCodePoints(0, Math.max(0, maxCodePoints - 1));
        return cleaned.substring(0, end).stripTrailing() + ELLIPSIS;
    }
}
