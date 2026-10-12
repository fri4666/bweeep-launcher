package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.Notice;
import com.fri4666.bweeep.notify.core.NoticeController;
import com.mojang.logging.LogUtils;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.client.event.RegisterGuiOverlaysEvent;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.EventPriority;
import net.minecraftforge.eventbus.api.IEventBus;
import org.slf4j.Logger;

import java.util.Optional;

/**
 * Shows notices that a server sends as system messages with the key
 * {@code bweeep.notice} (see {@code NoticeParser}). The server needs no mod.
 * A notice is taken out of the chat; without this mod the message's
 * {@code fallback} text appears in chat instead.
 */
final class ForgeNotifyClient {
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final NoticeController CONTROLLER = new NoticeController();

    private ForgeNotifyClient() {}

    static void init(IEventBus modBus) {
        LOGGER.info("{} 0.1.0 (forge) ready", BweeepNotifyMod.MOD_ID);
        modBus.addListener(ForgeNotifyClient::registerOverlay);
        // Player chat is a different event type, so only system messages reach onSystemMessage.
        MinecraftForge.EVENT_BUS.addListener(EventPriority.HIGH, ForgeNotifyClient::onSystemMessage);
        MinecraftForge.EVENT_BUS.addListener(ForgeNotifyClient::onScreenRendered);
    }

    private static void registerOverlay(RegisterGuiOverlaysEvent event) {
        // In the world the banner sits under any open screen on the HUD layer, so a screen layer repeats it above.
        event.registerAboveAll("notice", (gui, graphics, partialTick, width, height) -> {
            if (Minecraft.getInstance().screen == null) draw(graphics);
        });
    }

    private static void onScreenRendered(ScreenEvent.Render.Post event) {
        if (Minecraft.getInstance().level != null) draw(event.getGuiGraphics());
    }

    private static void onSystemMessage(ClientChatReceivedEvent.System event) {
        if (event.isOverlay()) return;
        Optional<Notice> notice = NoticeMessages.fromComponent(event.getMessage());
        if (notice.isEmpty()) return;
        boolean queued = CONTROLLER.offer(notice.get(), Util.getMillis());
        LOGGER.info("notice level={} chars={} hold={}ms queued={}", notice.get().level().wireName(),
                notice.get().text().length(), notice.get().holdMs(), queued);
        event.setCanceled(true);
    }

    private static void draw(GuiGraphics graphics) {
        Minecraft client = Minecraft.getInstance();
        if (client.options.hideGui) return;
        long now = Util.getMillis();
        CONTROLLER.tick(now).ifPresent(presented -> {
            if (presented.started()) {
                ForgeNoticeSound.play(presented.notice().level());
                LOGGER.info("show level={} ding pitch={}", presented.notice().level().wireName(), presented.notice().level().pitch());
            }
            BannerRenderer.render(graphics, client, presented, now);
        });
    }
}
