package com.fri4666.bweeep;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.handling.IPayloadContext;

final class BweeepClient {
    private static boolean connected;
    private static boolean stopping;
    private static final String TARGET_SERVER_PROPERTY = "bweeep.targetServer";
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
        if (!isSelectedServerAllowed()) {
            stopMinecraft();
            return;
        }
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
        var screen = event.getNewScreen();
        if (screen instanceof DisconnectedScreen
                || screen instanceof JoinMultiplayerScreen
                || screen instanceof SelectWorldScreen
                || (connected && screen instanceof TitleScreen)) {
            stopMinecraft();
        }
    }

    private static boolean isSelectedServerAllowed() {
        String required = normalizeAddress(System.getProperty(TARGET_SERVER_PROPERTY, ""));
        ServerData selected = Minecraft.getInstance().getCurrentServer();
        return !required.isEmpty() && selected != null && required.equals(normalizeAddress(selected.ip));
    }

    private static String normalizeAddress(String address) {
        String normalized = address == null ? "" : address.trim().toLowerCase(java.util.Locale.ROOT);
        if (normalized.isEmpty()) return "";
        if (normalized.startsWith("[") && normalized.indexOf(']') == normalized.length() - 1) return normalized + ":25565";
        if (!normalized.startsWith("[") && normalized.indexOf(':') < 0) return normalized + ":25565";
        return normalized;
    }

    private static void stopMinecraft() {
        if (stopping) return;
        stopping = true;
        Minecraft minecraft = Minecraft.getInstance();
        minecraft.execute(minecraft::stop);
    }
}
