package com.fri4666.bweeep.notify.core;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NoticeParserTest {
    private static Optional<Notice> parse(String level, String seconds, String text) {
        return NoticeParser.parse(NoticeParser.KEY, List.of(level, seconds, text));
    }

    @Test
    void readsLevelSecondsAndText() {
        Notice notice = parse("warning", "8", "서버를 곧 재시작합니다").orElseThrow();
        assertEquals(NoticeLevel.WARNING, notice.level());
        assertEquals(8_000, notice.holdMs());
        assertEquals("서버를 곧 재시작합니다", notice.text());
    }

    @Test
    void ignoresOtherKeysAndShortArgumentLists() {
        assertTrue(NoticeParser.parse("chat.type.text", List.of("info", "5", "hi")).isEmpty());
        assertTrue(NoticeParser.parse(NoticeParser.KEY, List.of("info", "5")).isEmpty());
        assertTrue(NoticeParser.parse(NoticeParser.KEY, null).isEmpty());
    }

    @Test
    void unknownLevelShowsAsInfoInsteadOfDroppingTheNotice() {
        assertEquals(NoticeLevel.INFO, parse("banana", "5", "hello").orElseThrow().level());
        assertEquals(NoticeLevel.URGENT, parse(" URGENT ", "5", "hello").orElseThrow().level());
    }

    @Test
    void holdFallsBackToDefaultAndIsClamped() {
        assertEquals(NoticeParser.DEFAULT_HOLD_MS, parse("info", "0", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.DEFAULT_HOLD_MS, parse("info", "abc", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.DEFAULT_HOLD_MS, parse("info", "-3", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.DEFAULT_HOLD_MS, parse("info", "NaN", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.MIN_HOLD_MS, parse("info", "0.5", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.MAX_HOLD_MS, parse("info", "9999", "x").orElseThrow().holdMs());
        assertEquals(NoticeParser.DEFAULT_HOLD_MS, parse("info", "Infinity", "x").orElseThrow().holdMs());
        assertEquals(3_000, parse("info", " 3 ", "x").orElseThrow().holdMs());
    }

    @Test
    void emptyTextAfterCleaningIsDropped() {
        assertTrue(parse("info", "5", "   ").isEmpty());
        assertTrue(parse("info", "5", "§a§l").isEmpty());
        assertTrue(parse("info", "5", "​‮").isEmpty());
    }

    @Test
    void textIsCutToTheLimitWithAnEllipsis() {
        String text = parse("info", "5", "a".repeat(250)).orElseThrow().text();
        assertEquals(NoticeText.MAX_CODE_POINTS, text.codePointCount(0, text.length()));
        assertTrue(text.endsWith("…"));
        assertEquals("a".repeat(99) + "…", text);
    }

    @Test
    void exactlyTheLimitIsKept() {
        String exact = "가".repeat(NoticeText.MAX_CODE_POINTS);
        assertEquals(exact, parse("info", "5", exact).orElseThrow().text());
    }

    @Test
    void cuttingNeverSplitsASurrogatePair() {
        String text = NoticeText.sanitize("😀".repeat(150), 100);
        assertEquals(100, text.codePointCount(0, text.length()));
        assertFalse(Character.isLowSurrogate(text.charAt(0)));
        assertTrue(text.endsWith("…"));
    }

    @Test
    void sanitizeRemovesFormattingControlAndInvisibleCharacters() {
        assertEquals("red text", NoticeText.sanitize("§cred§r text", 100));
        assertEquals("a b c", NoticeText.sanitize("a\n\tb\r\n  c", 100));
        assertEquals("ab", NoticeText.sanitize("a​b‮", 100));
        assertEquals("ab", NoticeText.sanitize("a\u0000b\u0007", 100));
        assertEquals("trailing", NoticeText.sanitize("  trailing  ", 100));
        assertEquals("", NoticeText.sanitize(null, 100));
    }

    @Test
    void aDanglingSectionSignAtTheEndIsDropped() {
        assertEquals("end", NoticeText.sanitize("end§", 100));
    }
}
