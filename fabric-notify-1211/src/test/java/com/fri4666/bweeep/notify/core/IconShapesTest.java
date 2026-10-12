package com.fri4666.bweeep.notify.core;

import com.fri4666.bweeep.notify.core.IconShapes.Rect;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IconShapesTest {
    @Test
    void everyRectStaysInsideTheGrid() {
        for (NoticeLevel level : NoticeLevel.values()) {
            for (Rect r : IconShapes.of(level)) {
                assertTrue(r.w() > 0 && r.h() > 0, level + " " + r);
                assertTrue(r.x() >= 0 && r.y() >= 0, level + " " + r);
                assertTrue(r.x() + r.w() <= IconShapes.GRID && r.y() + r.h() <= IconShapes.GRID, level + " " + r);
            }
        }
    }

    @Test
    void everyIconHasAShapeAndASymbol() {
        for (NoticeLevel level : NoticeLevel.values()) {
            List<Rect> rects = IconShapes.of(level);
            assertTrue(rects.stream().anyMatch(r -> !r.glyph()), level + " shape");
            assertTrue(rects.stream().anyMatch(Rect::glyph), level + " symbol");
        }
    }

    @Test
    void shapesAreSymmetricAroundTheMiddleColumn() {
        for (NoticeLevel level : NoticeLevel.values()) {
            for (Rect r : IconShapes.of(level)) {
                if (r.glyph()) continue;
                assertEquals(IconShapes.GRID, 2 * r.x() + r.w(), level + " " + r);
            }
        }
    }

    @Test
    void theFourLevelsLookDifferent() {
        Set<List<Rect>> seen = new HashSet<>();
        for (NoticeLevel level : NoticeLevel.values()) seen.add(IconShapes.of(level));
        assertEquals(NoticeLevel.values().length, seen.size());
        Set<Integer> accents = new HashSet<>();
        for (NoticeLevel level : NoticeLevel.values()) accents.add(level.accent());
        assertEquals(NoticeLevel.values().length, accents.size());
    }

    @Test
    void alertLevelsRankAndPitchSoUrgentIsHeardAsLower() {
        assertTrue(NoticeLevel.URGENT.priority() > NoticeLevel.WARNING.priority());
        assertTrue(NoticeLevel.WARNING.priority() > NoticeLevel.SUCCESS.priority());
        assertTrue(NoticeLevel.SUCCESS.priority() > NoticeLevel.INFO.priority());
        assertTrue(NoticeLevel.URGENT.pitch() < NoticeLevel.INFO.pitch());
    }

    @Test
    void wireNamesRoundTrip() {
        for (NoticeLevel level : NoticeLevel.values()) {
            assertEquals(level, NoticeLevel.fromWireName(level.wireName()).orElseThrow());
        }
        assertTrue(NoticeLevel.fromWireName("warn").isEmpty(), "the wire names are exact; typos fall back to info only in the mod");
    }
}
