package com.fri4666.bweeep.notify.core;

import com.fri4666.bweeep.notify.core.NoticeController.Presented;
import com.fri4666.bweeep.notify.core.BannerTimeline.Phase;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NoticeControllerTest {
    private static Notice notice(NoticeLevel level, String text) {
        return new Notice(level, text, 3_000);
    }

    @Test
    void emptyWhenNothingWasOffered() {
        assertTrue(new NoticeController().tick(0).isEmpty());
    }

    @Test
    void startIsReportedExactlyOnce() {
        NoticeController controller = new NoticeController();
        controller.offer(notice(NoticeLevel.INFO, "a"), 0);
        assertTrue(controller.tick(0).orElseThrow().started());
        assertFalse(controller.tick(16).orElseThrow().started());
        assertFalse(controller.tick(2_000).orElseThrow().started());
    }

    @Test
    void noticesShowOneAtATimeInOrderWithAGap() {
        NoticeController controller = new NoticeController();
        controller.offer(notice(NoticeLevel.INFO, "first"), 0);
        controller.offer(notice(NoticeLevel.INFO, "second"), 10);
        assertEquals("first", controller.tick(20).orElseThrow().notice().text());
        long end = 20 + BannerTimeline.totalMs(3_000);
        assertEquals("first", controller.tick(end - 1).orElseThrow().notice().text());
        assertTrue(controller.tick(end).isEmpty(), "gap between two banners");
        assertTrue(controller.tick(end + NoticeController.GAP_MS - 1).isEmpty());
        Presented next = controller.tick(end + NoticeController.GAP_MS).orElseThrow();
        assertEquals("second", next.notice().text());
        assertTrue(next.started());
    }

    @Test
    void moreImportantNoticesWaitAheadOfLessImportantOnes() {
        NoticeController controller = new NoticeController();
        controller.offer(notice(NoticeLevel.INFO, "on screen"), 0);
        controller.tick(0);
        controller.offer(notice(NoticeLevel.INFO, "info"), 10);
        controller.offer(notice(NoticeLevel.WARNING, "warning"), 20);
        controller.offer(notice(NoticeLevel.SUCCESS, "success"), 30);
        // "on screen" already started above, and the warning cuts it short
        List<String> order = drain(controller, 10);
        assertEquals(List.of("warning", "success", "info"), order);
    }

    @Test
    void sameLevelKeepsArrivalOrder() {
        NoticeController controller = new NoticeController();
        controller.offer(notice(NoticeLevel.WARNING, "w1"), 0);
        controller.offer(notice(NoticeLevel.WARNING, "w2"), 10);
        controller.offer(notice(NoticeLevel.WARNING, "w3"), 20);
        assertEquals(List.of("w1", "w2", "w3"), drain(controller, 30));
    }

    @Test
    void anUrgentNoticeCutsTheCurrentLowerOneShort() {
        NoticeController controller = new NoticeController();
        controller.offer(new Notice(NoticeLevel.INFO, "long", 20_000), 0);
        controller.tick(0);
        controller.offer(notice(NoticeLevel.URGENT, "now"), 1_000);
        // 1000 ms in: enter (380) is over, so the hold is cut to what has passed (620 ms)
        long exitStart = BannerTimeline.ENTER_MS + 620;
        assertEquals(Phase.HOLD, controller.tick(exitStart - 1).orElseThrow().frame().phase());
        assertEquals(Phase.EXIT, controller.tick(exitStart + 10).orElseThrow().frame().phase());
        long gone = exitStart + BannerTimeline.EXIT_MS;
        assertTrue(controller.tick(gone).isEmpty());
        assertEquals("now", controller.tick(gone + NoticeController.GAP_MS).orElseThrow().notice().text());
    }

    @Test
    void aNoticeOfTheSameOrLowerLevelDoesNotCutTheCurrentOne() {
        NoticeController controller = new NoticeController();
        controller.offer(new Notice(NoticeLevel.WARNING, "stays", 20_000), 0);
        controller.tick(0);
        controller.offer(notice(NoticeLevel.WARNING, "other"), 1_000);
        controller.offer(notice(NoticeLevel.INFO, "lower"), 1_100);
        assertEquals(Phase.HOLD, controller.tick(15_000).orElseThrow().frame().phase());
    }

    @Test
    void anUrgentNoticeArrivingDuringTheEnterAnimationClosesRightAfterIt() {
        NoticeController controller = new NoticeController();
        controller.offer(new Notice(NoticeLevel.INFO, "fresh", 20_000), 0);
        controller.tick(0);
        controller.offer(notice(NoticeLevel.URGENT, "now"), 100);
        assertEquals(Phase.EXIT, controller.tick(BannerTimeline.ENTER_MS).orElseThrow().frame().phase());
    }

    @Test
    void identicalNoticesInQuickSuccessionAreShownOnce() {
        NoticeController controller = new NoticeController();
        assertTrue(controller.offer(notice(NoticeLevel.INFO, "same"), 0));
        assertFalse(controller.offer(notice(NoticeLevel.INFO, "same"), 500));
        assertFalse(controller.offer(notice(NoticeLevel.INFO, "same"), 1_000));
        assertEquals(1, controller.pendingCount());
        assertTrue(controller.offer(notice(NoticeLevel.INFO, "same"), 1_000 + NoticeController.DUPLICATE_WINDOW_MS),
                "after a quiet window the same text is a new notice");
        assertTrue(controller.offer(notice(NoticeLevel.URGENT, "same"), 1_000 + NoticeController.DUPLICATE_WINDOW_MS + 1),
                "another level is not a repeat");
    }

    @Test
    void aFullQueueDropsTheLeastImportantNewestNotice() {
        NoticeController controller = new NoticeController();
        for (int i = 0; i < NoticeController.MAX_PENDING; i++) {
            assertTrue(controller.offer(notice(NoticeLevel.INFO, "info " + i), i * 2_000L));
        }
        assertEquals(NoticeController.MAX_PENDING, controller.pendingCount());
        assertTrue(controller.offer(notice(NoticeLevel.URGENT, "urgent"), 100_000));
        assertEquals(NoticeController.MAX_PENDING, controller.pendingCount());
        assertTrue(controller.offer(notice(NoticeLevel.INFO, "late info"), 102_000), "an info replaces the newest info");
        // fill with urgent ones: a lower notice can no longer get in
        NoticeController urgent = new NoticeController();
        for (int i = 0; i < NoticeController.MAX_PENDING; i++) urgent.offer(notice(NoticeLevel.URGENT, "u" + i), i * 2_000L);
        assertFalse(urgent.offer(notice(NoticeLevel.INFO, "dropped"), 50_000));
    }

    @Test
    void theQueueIsEmptyAgainAfterEverythingHasShown() {
        NoticeController controller = new NoticeController();
        controller.offer(notice(NoticeLevel.INFO, "a"), 0);
        drain(controller, 0);
        assertEquals(0, controller.pendingCount());
        assertTrue(controller.tick(10_000_000).isEmpty());
    }

    /** Runs the clock forward and returns the texts in the order they started. */
    private static List<String> drain(NoticeController controller, long start) {
        List<String> order = new ArrayList<>();
        for (long now = start; now < start + 120_000; now += 16) {
            Optional<Presented> presented = controller.tick(now);
            if (presented.isPresent() && presented.get().started()) order.add(presented.get().notice().text());
        }
        return order;
    }
}
