package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.BannerTimeline;
import com.fri4666.bweeep.notify.core.IconShapes;
import com.fri4666.bweeep.notify.core.NoticeController.Presented;
import com.fri4666.bweeep.notify.core.NoticeLevel;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;

import java.util.List;

/**
 * Draws the banner with plain fills, so it needs no textures. The frame
 * (body and border) follows the closing width; the content keeps its place
 * and is clipped to the frame, so the ends sweep over it toward the centre.
 */
final class BannerRenderer {
    private static final int TOP_MARGIN = 10;
    private static final int PADDING = 8;
    private static final int GAP = 8;
    private static final int MAX_LINES = 3;
    private static final int TEXT_COLOR = 0xFFF4F6F8;
    private static final int GLYPH_COLOR = 0xFF101418;

    private BannerRenderer() {}

    static void render(GuiGraphics g, Minecraft mc, Presented presented, long nowMs) {
        BannerTimeline.Frame frame = presented.frame();
        NoticeLevel level = presented.notice().level();
        Font font = mc.font;
        int screenWidth = g.guiWidth();

        int maxText = Math.max(80, Math.min((int) (screenWidth * 0.7) - 56, 300));
        List<FormattedCharSequence> lines = font.split(Component.literal(presented.notice().text()), maxText);
        if (lines.size() > MAX_LINES) lines = lines.subList(0, MAX_LINES);
        int textWidth = 0;
        for (FormattedCharSequence line : lines) textWidth = Math.max(textWidth, font.width(line));

        int lineHeight = font.lineHeight + 1;
        int textHeight = lines.size() * lineHeight - 1;
        int fullWidth = 2 + PADDING + IconShapes.GRID + GAP + textWidth + PADDING;
        int height = Math.max(IconShapes.GRID, textHeight) + 2 * PADDING;

        int width = Math.round(fullWidth * frame.width());
        if (width < 2) return;
        int centre = screenWidth / 2;
        int left = centre - width / 2;
        int top = Math.round(lerp(-height - 6, TOP_MARGIN, frame.slide()));
        float alpha = frame.alpha();

        int border = withAlpha(pulse(level, nowMs), alpha);
        fillRounded(g, left, top + 2, width, height, withAlpha(0x66000000, alpha));
        fillRounded(g, left, top, width, height, border);
        if (width > 4) fillRounded(g, left + 1, top + 1, width - 2, height - 2, withAlpha(level.background(), alpha));

        if (alpha * 255f < 5f) return;
        int contentLeft = centre - fullWidth / 2 + 1 + PADDING;
        int iconTop = top + (height - IconShapes.GRID) / 2;
        g.enableScissor(left + 1, top, left + width - 1, top + height);
        int shape = withAlpha(level.accent(), alpha);
        int glyph = withAlpha(GLYPH_COLOR, alpha);
        for (IconShapes.Rect rect : IconShapes.of(level)) {
            int x = contentLeft + rect.x();
            int y = iconTop + rect.y();
            g.fill(x, y, x + rect.w(), y + rect.h(), rect.glyph() ? glyph : shape);
        }
        int textLeft = contentLeft + IconShapes.GRID + GAP;
        int textTop = top + (height - textHeight) / 2;
        int textColor = withAlpha(TEXT_COLOR, alpha);
        for (int i = 0; i < lines.size(); i++) {
            g.drawString(font, lines.get(i), textLeft, textTop + i * lineHeight, textColor, false);
        }
        g.disableScissor();
    }

    /** Urgent notices breathe: the border drifts toward white and back. */
    private static int pulse(NoticeLevel level, long nowMs) {
        if (level != NoticeLevel.URGENT) return level.accent();
        float t = (float) ((Math.sin(nowMs / 140.0) + 1.0) / 2.0) * 0.5f;
        return mix(level.accent(), 0xFFFFD7D7, t);
    }

    private static void fillRounded(GuiGraphics g, int x, int y, int w, int h, int color) {
        if (w < 3 || h < 3) {
            g.fill(x, y, x + w, y + h, color);
            return;
        }
        g.fill(x + 1, y, x + w - 1, y + h, color);
        g.fill(x, y + 1, x + w, y + h - 1, color);
    }

    private static float lerp(float a, float b, float t) {
        return a + (b - a) * t;
    }

    private static int withAlpha(int argb, float alpha) {
        int a = Math.round(((argb >>> 24) & 0xFF) * Math.max(0f, Math.min(1f, alpha)));
        return (a << 24) | (argb & 0xFFFFFF);
    }

    private static int mix(int from, int to, float t) {
        int r = Math.round(lerp((from >> 16) & 0xFF, (to >> 16) & 0xFF, t));
        int gr = Math.round(lerp((from >> 8) & 0xFF, (to >> 8) & 0xFF, t));
        int b = Math.round(lerp(from & 0xFF, to & 0xFF, t));
        return 0xFF000000 | (r << 16) | (gr << 8) | b;
    }
}
