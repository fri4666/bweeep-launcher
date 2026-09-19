package com.fri4666.bweeepname;

import net.minecraft.world.item.Item;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

@Mod(BweeepDisplayNameMod.MOD_ID)
public final class BweeepDisplayNameMod {
    static final String MOD_ID = "bweeep_display_name";
    private static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(MOD_ID);
    static final DeferredItem<Item> NAME_TOKEN = ITEMS.register("name_token", () -> new NameTokenItem(
        new Item.Properties().stacksTo(1)
    ));

    public BweeepDisplayNameMod(IEventBus modBus, ModContainer ignoredContainer) {
        ITEMS.register(modBus);
        modBus.addListener(this::registerPayloads);
        modBus.addListener(DisplayNameServer::registerConfigurationTask);
        NeoForge.EVENT_BUS.addListener(DisplayNameServer::onPlayerLogin);
        NeoForge.EVENT_BUS.addListener(DisplayNameServer::onPlayerLogout);
        NeoForge.EVENT_BUS.addListener(DisplayNameServer::onServerTick);
        NeoForge.EVENT_BUS.addListener(DisplayNameServer::onNameFormat);
        NeoForge.EVENT_BUS.addListener(DisplayNameServer::onTabListNameFormat);
    }

    private void registerPayloads(RegisterPayloadHandlersEvent event) {
        PayloadRegistrar registrar = event.registrar("2");
        registrar.commonToServer(SubmitNamePayload.TYPE, SubmitNamePayload.STREAM_CODEC, DisplayNameServer::handleSubmission);
        registrar.commonToClient(OpenNameScreenPayload.TYPE, OpenNameScreenPayload.STREAM_CODEC, (payload, context) -> {
            if (FMLEnvironment.dist == Dist.CLIENT) DisplayNameClient.openScreen(payload, context);
        });
        registrar.commonToClient(DisplayNameResultPayload.TYPE, DisplayNameResultPayload.STREAM_CODEC, (payload, context) -> {
            if (FMLEnvironment.dist == Dist.CLIENT) DisplayNameClient.handleResult(payload, context);
        });
    }
}
