package com.fri4666.bweeepname;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class DisplayNameRulesTest {
    @Test
    void acceptsKoreanLatinNumbersSpacesAndUnderscores() {
        assertEquals("서오스 py_01", DisplayNameRules.normalize("  서오스  py_01  "));
    }

    @Test
    void rejectsFormattingPunctuationAndInvalidLengths() {
        assertNull(DisplayNameRules.normalize("a"));
        assertNull(DisplayNameRules.normalize("name§c"));
        assertNull(DisplayNameRules.normalize("12345678901234567"));
    }
}
