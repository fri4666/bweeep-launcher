package com.fri4666.bweeep.lock;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;

public final class BweeepConnectionLockClient implements ClientModInitializer {
    private boolean joined;
    private boolean stopping;

    @Override
    public void onInitializeClient() {
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> joined = true);
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            if (!joined || stopping) return;
            joined = false;
            stopping = true;
            client.execute(client::stop);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> stopping = true);
    }
}
