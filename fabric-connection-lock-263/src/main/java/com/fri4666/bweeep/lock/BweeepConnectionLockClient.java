package com.fri4666.bweeep.lock;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;

public final class BweeepConnectionLockClient implements ClientModInitializer {
    // The launcher watches the game's stdout for these markers to show
    // "joined", "left" and "rejected" states instead of a silent exit.
    private static final String JOINED_MARKER = "BWEEP_TARGET_JOINED";
    private static final String LEFT_MARKER = "BWEEP_TARGET_LEFT";
    private static final String REJECTED_MARKER = "BWEEP_TARGET_REJECTED";

    private boolean joined;
    private boolean stopping;

    @Override
    public void onInitializeClient() {
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            if (screen instanceof DisconnectedScreen
                    || screen instanceof JoinMultiplayerScreen
                    || screen instanceof SelectWorldScreen
                    || (joined && screen instanceof TitleScreen)) {
                if (screen instanceof DisconnectedScreen && !joined) System.out.println(REJECTED_MARKER);
                markLeft();
                stop(client);
            }
        });
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            if (!matchesSelectedServer(client)) {
                stop(client);
                return;
            }
            if (!joined) {
                joined = true;
                System.out.println(JOINED_MARKER);
            }
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            if (!joined) return;
            markLeft();
            stop(client);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> stopping = true);
    }

    private void markLeft() {
        if (!joined) return;
        joined = false;
        System.out.println(LEFT_MARKER);
    }

    private boolean matchesSelectedServer(Minecraft client) {
        String required = normalizeAddress(System.getProperty("bweeep.targetServer", ""));
        ServerData selected = client.getCurrentServer();
        return !required.isEmpty() && selected != null && required.equals(normalizeAddress(selected.ip));
    }

    private String normalizeAddress(String address) {
        String normalized = address == null ? "" : address.trim().toLowerCase(java.util.Locale.ROOT);
        if (normalized.isEmpty()) return "";
        if (normalized.startsWith("[") && normalized.indexOf(']') == normalized.length() - 1) return normalized + ":25565";
        if (!normalized.startsWith("[") && normalized.indexOf(':') < 0) return normalized + ":25565";
        return normalized;
    }

    private void stop(Minecraft client) {
        if (stopping) return;
        stopping = true;
        client.execute(client::stop);
    }
}
