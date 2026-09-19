package com.fri4666.bweeepname;

import net.minecraft.client.Minecraft;
import net.neoforged.neoforge.network.handling.IPayloadContext;

final class DisplayNameClient {
    private DisplayNameClient() {}

    static void openScreen(OpenNameScreenPayload payload, IPayloadContext context) {
        context.enqueueWork(() -> Minecraft.getInstance().setScreen(new DisplayNameScreen(payload.gameName())));
    }

    static void handleResult(DisplayNameResultPayload payload, IPayloadContext context) {
        context.enqueueWork(() -> {
            if (Minecraft.getInstance().screen instanceof DisplayNameScreen screen) {
                screen.handleResult(payload);
                if (payload.success()) Minecraft.getInstance().setScreen(null);
            }
        });
    }
}
