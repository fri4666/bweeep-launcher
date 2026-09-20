package com.fri4666.bweeep.fabric.lock;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(DisconnectedScreen.class)
abstract class DisconnectedScreenExitMixin {
    @Inject(method = "init", at = @At("HEAD"))
    private void bweeep$exitOnDisconnect(CallbackInfo callback) {
        Minecraft.getInstance().stop();
    }
}
