package com.fri4666.bweeep;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.handling.IPayloadContext;

final class BweeepClient {
    private static boolean connected;
    private static boolean stopping;
    private static boolean ticketSent;

    private BweeepClient() {}

    static void handleTicketRequest(TicketRequestPayload ignored, IPayloadContext context) {
        String ticket = System.getenv("BWEEP_GAME_TICKET");
        if (ticket == null || ticket.isBlank()) {
            context.disconnect(net.minecraft.network.chat.Component.literal("붸에엡 런처 인증 정보가 없습니다."));
            return;
        }
        ticketSent = true;
        context.reply(new GameTicketPayload(ticket));
    }

    static void register() {
        NeoForge.EVENT_BUS.addListener(BweeepClient::onLogin);
        NeoForge.EVENT_BUS.addListener(BweeepClient::onLogout);
        NeoForge.EVENT_BUS.addListener(BweeepClient::onScreenOpening);
    }

    private static void onLogin(ClientPlayerNetworkEvent.LoggingIn event) {
        connected = true;
        if (ticketSent) return;
        String ticket = System.getenv("BWEEP_GAME_TICKET");
        if (ticket == null || ticket.isBlank()) return;
        PacketDistributor.sendToServer(new GameTicketPayload(ticket));
        ticketSent = true;
    }

    private static void onLogout(ClientPlayerNetworkEvent.LoggingOut event) {
        if (connected) {
            connected = false;
            stopMinecraft();
        }
    }

    private static void onScreenOpening(ScreenEvent.Opening event) {
        if (event.getNewScreen() instanceof DisconnectedScreen) {
            stopMinecraft();
        }
    }

    private static void stopMinecraft() {
        if (stopping) return;
        stopping = true;
        Minecraft minecraft = Minecraft.getInstance();
        minecraft.execute(minecraft::stop);
    }
}
