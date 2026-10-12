package com.fri4666.bweeep.notify;

import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.fml.loading.FMLEnvironment;

/**
 * Entry point. The mod is client-only: on a dedicated server it loads and does
 * nothing, so a copy that ends up in a server's mods folder is harmless.
 */
@Mod(BweeepNotifyMod.MOD_ID)
public final class BweeepNotifyMod {
    public static final String MOD_ID = "bweeep_notify";

    public BweeepNotifyMod() {
        if (FMLEnvironment.dist == Dist.CLIENT) {
            ForgeNotifyClient.init(FMLJavaModLoadingContext.get().getModEventBus());
        }
    }
}
