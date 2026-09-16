package com.fri4666.bweeep;

import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;

@Mod(BweeepMod.MOD_ID)
public final class BweeepMod {
    public static final String MOD_ID = "bweeep_client";

    public BweeepMod(IEventBus modBus, ModContainer ignoredContainer) {
        modBus.addListener(this::registerPayloads);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onPlayerLogin);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onPlayerLogout);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onServerTick);
        if (FMLEnvironment.dist == Dist.CLIENT) {
            BweeepClient.register();
        }
    }

    private void registerPayloads(RegisterPayloadHandlersEvent event) {
        event.registrar("1").playToServer(
            GameTicketPayload.TYPE,
            GameTicketPayload.STREAM_CODEC,
            BweeepServer::handleTicket
        );
    }
}
