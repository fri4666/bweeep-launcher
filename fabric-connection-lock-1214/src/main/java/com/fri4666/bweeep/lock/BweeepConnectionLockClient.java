package com.fri4666.bweeep.lock;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;

public final class BweeepConnectionLockClient implements ClientModInitializer {
    private boolean joined;
    private boolean stopping;

    @Override
    public void onInitializeClient() {
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            if (screen instanceof TitleScreen || screen instanceof JoinMultiplayerScreen || screen instanceof DisconnectedScreen) {
                stop(client);
            }
        });
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> joined = true);
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            if (!joined) return;
            joined = false;
            stop(client);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> stopping = true);
    }

    private void stop(Minecraft client) {
        if (stopping) return;
        stopping = true;
        client.execute(client::stop);
    }
}
