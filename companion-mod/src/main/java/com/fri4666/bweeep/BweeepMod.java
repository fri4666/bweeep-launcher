package com.fri4666.bweeep;

import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;

@Mod(BweeepMod.MOD_ID)
public final class BweeepMod {
    public static final String MOD_ID = "bweeep_client";

    public BweeepMod(IEventBus modBus, ModContainer ignoredContainer) {
        modBus.addListener(this::registerPayloads);
        modBus.addListener(BweeepServer::registerConfigurationTask);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onPlayerLogin);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onPlayerLogout);
        NeoForge.EVENT_BUS.addListener(BweeepServer::onServerTick);
        if (FMLEnvironment.dist == Dist.CLIENT) {
            BweeepClient.register();
        }
    }

    private void registerPayloads(RegisterPayloadHandlersEvent event) {
        PayloadRegistrar registrar = event.registrar("2");
        registrar.commonToServer(
            GameTicketPayload.TYPE,
            GameTicketPayload.STREAM_CODEC,
            BweeepServer::handleTicket
        );
        registrar.configurationToClient(
            TicketRequestPayload.TYPE,
            TicketRequestPayload.STREAM_CODEC,
            BweeepClient::handleTicketRequest
        );
    }
}
