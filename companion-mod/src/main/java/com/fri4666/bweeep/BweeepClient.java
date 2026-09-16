package com.fri4666.bweeep;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;

@Mod(value = BweeepClient.MOD_ID, dist = Dist.CLIENT)
public final class BweeepClient {
    public static final String MOD_ID = "bweeep_client";
    private boolean connected;
    private boolean stopping;

    public BweeepClient() {
        NeoForge.EVENT_BUS.addListener(this::onLogin);
        NeoForge.EVENT_BUS.addListener(this::onLogout);
        NeoForge.EVENT_BUS.addListener(this::onScreenOpening);
    }

    private void onLogin(ClientPlayerNetworkEvent.LoggingIn event) {
        connected = true;
    }

    private void onLogout(ClientPlayerNetworkEvent.LoggingOut event) {
        if (connected) {
            connected = false;
            stopMinecraft();
        }
    }

    private void onScreenOpening(ScreenEvent.Opening event) {
        if (event.getNewScreen() instanceof DisconnectedScreen) {
            stopMinecraft();
        }
    }

    private void stopMinecraft() {
        if (stopping) return;
        stopping = true;
        Minecraft minecraft = Minecraft.getInstance();
        minecraft.execute(minecraft::stop);
    }
}
