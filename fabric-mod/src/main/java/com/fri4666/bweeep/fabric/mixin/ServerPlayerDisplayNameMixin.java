package com.fri4666.bweeep.fabric.mixin;

import com.fri4666.bweeep.fabric.DisplayNames;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ServerPlayer.class)
abstract class ServerPlayerDisplayNameMixin {
    @Inject(method = "getTabListDisplayName", at = @At("HEAD"), cancellable = true)
    private void bweeep$displayName(CallbackInfoReturnable<Component> callback) {
        String name = DisplayNames.visibleName((ServerPlayer) (Object) this);
        if (name != null) callback.setReturnValue(Component.literal(name));
    }
}
