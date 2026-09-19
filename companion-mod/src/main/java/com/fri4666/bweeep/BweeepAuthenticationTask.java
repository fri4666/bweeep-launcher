package com.fri4666.bweeep;

import java.util.function.Consumer;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.network.ConfigurationTask;
import net.neoforged.neoforge.network.configuration.ICustomConfigurationTask;

record BweeepAuthenticationTask() implements ICustomConfigurationTask {
    static final ConfigurationTask.Type TYPE = new ConfigurationTask.Type(
        ResourceLocation.fromNamespaceAndPath(BweeepMod.MOD_ID, "authenticate")
    );

    @Override
    public void run(Consumer<CustomPacketPayload> sender) {
        sender.accept(TicketRequestPayload.INSTANCE);
    }

    @Override
    public ConfigurationTask.Type type() {
        return TYPE;
    }
}
