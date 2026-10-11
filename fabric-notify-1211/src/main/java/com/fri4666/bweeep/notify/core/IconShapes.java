package com.fri4666.bweeep.notify.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Icons as rectangles on a 16x16 grid, so they need no image files and draw
 * the same on any loader. {@code glyph} rectangles are the symbol drawn on the
 * coloured shape (info: i, success: check, warning: !, urgent: !).
 */
public final class IconShapes {
    public static final int GRID = 16;

    public record Rect(int x, int y, int w, int h, boolean glyph) {}

    private IconShapes() {}

    public static List<Rect> of(NoticeLevel level) {
        List<Rect> rects = new ArrayList<>();
        switch (level) {
            case INFO -> {
                circle(rects);
                rects.add(new Rect(7, 3, 2, 2, true));
                rects.add(new Rect(7, 6, 2, 7, true));
            }
            case SUCCESS -> {
                circle(rects);
                // down stroke, then up stroke of the tick, 2x2 pixels each
                int[][] tick = {{4, 8}, {5, 9}, {6, 10}, {7, 9}, {8, 8}, {9, 7}, {10, 6}, {11, 5}};
                for (int[] p : tick) rects.add(new Rect(p[0], p[1], 2, 2, true));
            }
            case WARNING -> {
                for (int y = 1; y <= 14; y++) {
                    double half = 0.5 + (y - 1) / 13.0 * 7.0;
                    int w = 2 * Math.max(1, (int) Math.round(half));
                    rects.add(new Rect(GRID / 2 - w / 2, y, w, 1, false));
                }
                rects.add(new Rect(7, 6, 2, 4, true));
                rects.add(new Rect(7, 11, 2, 2, true));
            }
            case URGENT -> {
                for (int y = 0; y < GRID; y++) {
                    int d = Math.min(y, GRID - 1 - y);
                    int w = 2 * (d + 1);
                    rects.add(new Rect(GRID / 2 - w / 2, y, w, 1, false));
                }
                rects.add(new Rect(7, 3, 2, 6, true));
                rects.add(new Rect(7, 10, 2, 2, true));
            }
        }
        return rects;
    }

    private static void circle(List<Rect> rects) {
        double radius = 7.6;
        for (int y = 0; y < GRID; y++) {
            double dy = y + 0.5 - GRID / 2.0;
            double squared = radius * radius - dy * dy;
            if (squared <= 0) continue;
            int w = (int) Math.round(Math.sqrt(squared) * 2) & ~1;
            if (w < 2) w = 2;
            rects.add(new Rect(GRID / 2 - w / 2, y, w, 1, false));
        }
    }
}
