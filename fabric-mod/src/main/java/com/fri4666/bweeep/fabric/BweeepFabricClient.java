package com.fri4666.bweeep.fabric;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.networking.v1.ClientConfigurationNetworking;
import net.minecraft.client.Minecraft;

public final class BweeepFabricClient implements ClientModInitializer {
    private static boolean ticketSent;
    private static boolean stopping;

    @Override
    public void onInitializeClient() {
        ClientConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.TicketRequest.TYPE, (payload, context) -> {
            String ticket = System.getenv("BWEEP_GAME_TICKET");
            if (ticket == null || ticket.isBlank()) {
                context.responseSender().sendPacket(new BweeepProtocol.GameTicket(""));
                return;
            }
            ticketSent = true;
            context.responseSender().sendPacket(new BweeepProtocol.GameTicket(ticket));
        });
        ClientConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.OpenNameScreen.TYPE, (payload, context) ->
            context.client().execute(() -> context.client().setScreen(new DisplayNameScreen(payload.gameName(), true)))
        );
        ClientConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.DisplayNameResult.TYPE, (payload, context) ->
            context.client().execute(() -> handleNameResult(context.client(), payload))
        );
        ClientPlayNetworking.registerGlobalReceiver(BweeepProtocol.OpenNameScreen.TYPE, (payload, context) ->
            context.client().execute(() -> context.client().setScreen(new DisplayNameScreen(payload.gameName(), false)))
        );
        ClientPlayNetworking.registerGlobalReceiver(BweeepProtocol.DisplayNameResult.TYPE, (payload, context) ->
            context.client().execute(() -> {
                handleNameResult(context.client(), payload);
            })
        );
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            if (ticketSent) return;
            String ticket = System.getenv("BWEEP_GAME_TICKET");
            if (ticket != null && !ticket.isBlank()) {
                ClientPlayNetworking.send(new BweeepProtocol.GameTicket(ticket));
                ticketSent = true;
            }
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> stop(client));
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> stopping = true);
    }

    private static void handleNameResult(Minecraft client, BweeepProtocol.DisplayNameResult payload) {
        if (client.screen instanceof DisplayNameScreen screen) {
            screen.handleResult(payload);
            if (payload.success()) client.setScreen(null);
        }
    }

    private static void stop(Minecraft client) {
        if (stopping) return;
        stopping = true;
        client.execute(client::stop);
    }
}
