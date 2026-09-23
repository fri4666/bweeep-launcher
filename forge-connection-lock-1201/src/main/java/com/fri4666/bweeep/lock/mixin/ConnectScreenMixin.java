package com.fri4666.bweeep.lock.mixin;

import com.fri4666.bweeep.lock.BweeepConnectionLock;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ConnectScreen.class)
public abstract class ConnectScreenMixin {
    @Inject(method = "startConnecting", at = @At("HEAD"), cancellable = true)
    private static void bweeep$beforeConnect(
            Screen parent,
            Minecraft minecraft,
            ServerAddress address,
            ServerData selected,
            boolean quickPlay,
            CallbackInfo callback
    ) {
        if (!BweeepConnectionLock.allowConnection(address, selected)) {
            callback.cancel();
            minecraft.execute(minecraft::stop);
        }
    }
}