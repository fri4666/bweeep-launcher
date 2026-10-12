package com.fri4666.bweeep.notify.core;

import com.fri4666.bweeep.notify.core.BannerTimeline.Frame;
import com.fri4666.bweeep.notify.core.BannerTimeline.Phase;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BannerTimelineTest {
    private static final int HOLD = 5_000;

    @Test
    void startsHiddenAboveTheScreen() {
        Frame frame = BannerTimeline.at(0, HOLD);
        assertEquals(Phase.ENTER, frame.phase());
        assertEquals(0f, frame.slide(), 1e-6);
        assertEquals(0f, frame.alpha(), 1e-6);
        assertEquals(1f, frame.width(), 1e-6);
    }

    @Test
    void entersThenHoldsOpen() {
        Frame landed = BannerTimeline.at(BannerTimeline.ENTER_MS, HOLD);
        assertEquals(Phase.HOLD, landed.phase());
        assertEquals(1f, landed.slide(), 1e-6);
        assertEquals(1f, landed.width(), 1e-6);
        Frame middle = BannerTimeline.at(BannerTimeline.ENTER_MS + HOLD / 2, HOLD);
        assertEquals(Phase.HOLD, middle.phase());
        assertEquals(1f, middle.alpha(), 1e-6);
    }

    @Test
    void slideOnlyMovesDownwardWhileEntering() {
        float previous = -1f;
        for (int t = 0; t <= BannerTimeline.ENTER_MS; t += 10) {
            float slide = BannerTimeline.at(t, HOLD).slide();
            assertTrue(slide >= previous);
            previous = slide;
        }
    }

    @Test
    void closesInwardFromFullWidthToNothing() {
        long exitStart = BannerTimeline.ENTER_MS + HOLD;
        assertEquals(1f, BannerTimeline.at(exitStart, HOLD).width(), 1e-6);
        float previous = 1f;
        for (long t = exitStart; t < exitStart + BannerTimeline.EXIT_MS; t += 7) {
            Frame frame = BannerTimeline.at(t, HOLD);
            assertEquals(Phase.EXIT, frame.phase());
            assertTrue(frame.width() <= previous, "width must never grow while closing");
            assertEquals(1f, frame.slide(), 1e-6, "it closes in place, it does not move");
            previous = frame.width();
        }
        assertTrue(previous < 0.05f);
    }

    @Test
    void finishesExactlyWhenTheClosingEnds() {
        long end = BannerTimeline.totalMs(HOLD);
        assertFalse(BannerTimeline.at(end - 1, HOLD).finished());
        Frame done = BannerTimeline.at(end, HOLD);
        assertTrue(done.finished());
        assertEquals(Phase.DONE, done.phase());
        assertEquals(0f, done.width(), 1e-6);
    }

    @Test
    void zeroHoldGoesStraightFromEnterToExit() {
        assertEquals(Phase.EXIT, BannerTimeline.at(BannerTimeline.ENTER_MS, 0).phase());
        assertTrue(BannerTimeline.at(BannerTimeline.totalMs(0), 0).finished());
    }

    @Test
    void negativeElapsedIsTreatedAsZero() {
        assertEquals(BannerTimeline.at(0, HOLD), BannerTimeline.at(-50, HOLD));
    }

    @Test
    void easingStaysInRangeAndHitsItsEnds() {
        for (float t = -0.5f; t <= 1.5f; t += 0.05f) {
            for (float v : new float[] {Easing.outCubic(t), Easing.inCubic(t), Easing.inOutCubic(t)}) {
                assertTrue(v >= 0f && v <= 1f);
            }
        }
        assertEquals(0f, Easing.inOutCubic(0f), 1e-6);
        assertEquals(1f, Easing.inOutCubic(1f), 1e-6);
        assertEquals(0.5f, Easing.inOutCubic(0.5f), 1e-6);
    }
}
