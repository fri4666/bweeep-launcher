package com.fri4666.bweeep.fabric;

import java.util.function.Consumer;
import net.fabricmc.fabric.api.networking.v1.ServerConfigurationNetworking;
import net.minecraft.network.protocol.Packet;
import net.minecraft.server.network.ConfigurationTask;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;

record FabricConfigurationTask(ServerConfigurationPacketListenerImpl listener) implements ConfigurationTask {
    static final Type TYPE = new Type(BweeepFabric.MOD_ID + ":authenticate_and_choose_name");

    @Override
    public void start(Consumer<Packet<?>> sender) {
        sender.accept(ServerConfigurationNetworking.createS2CPacket(BweeepProtocol.TicketRequest.INSTANCE));
    }

    @Override
    public Type type() {
        return TYPE;
    }
}
