package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.Notice;
import com.fri4666.bweeep.notify.core.NoticeController;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

/**
 * Shows notices that a server sends as system messages with the key
 * {@code bweeep.notice} (see {@code NoticeParser}). The server needs no mod.
 * A notice is taken out of the chat; without this mod the message's
 * {@code fallback} text appears in chat instead.
 */
public final class NotifyClient implements ClientModInitializer {
    public static final String MOD_ID = "bweeep_notify";
    private static final Logger LOGGER = LoggerFactory.getLogger("bweeep-notify");
    private static final NoticeController CONTROLLER = new NoticeController();

    @Override
    public void onInitializeClient() {
        ClientReceiveMessageEvents.ALLOW_GAME.register(NotifyClient::onGameMessage);
        // In the world the banner sits under any open screen on the HUD layer, so a screen layer repeats it above.
        HudRenderCallback.EVENT.register((graphics, tickCounter) -> {
            if (Minecraft.getInstance().screen == null) draw(graphics);
        });
        ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
            if (client.level == null) return;
            ScreenEvents.afterRender(screen).register((s, graphics, mouseX, mouseY, delta) -> draw(graphics));
        });
    }

    private static boolean onGameMessage(Component message, boolean overlay) {
        if (overlay) return true;
        Optional<Notice> notice = NoticeMessages.fromComponent(message);
        if (notice.isEmpty()) return true;
        boolean queued = CONTROLLER.offer(notice.get(), Util.getMillis());
        LOGGER.info("notice level={} chars={} hold={}ms queued={}", notice.get().level().wireName(),
                notice.get().text().length(), notice.get().holdMs(), queued);
        return false;
    }

    private static void draw(GuiGraphics graphics) {
        Minecraft client = Minecraft.getInstance();
        if (client.options.hideGui) return;
        long now = Util.getMillis();
        CONTROLLER.tick(now).ifPresent(presented -> {
            if (presented.started()) {
                NoticeSound.play(presented.notice().level());
                LOGGER.info("show level={} ding pitch={}", presented.notice().level().wireName(), presented.notice().level().pitch());
            }
            BannerRenderer.render(graphics, client, presented, now);
        });
    }
}
