package com.fri4666.bweeepname;

import com.fri4666.bweeep.BweeepServer;
import java.util.function.Consumer;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.network.ConfigurationTask;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import net.neoforged.neoforge.network.configuration.ICustomConfigurationTask;

record DisplayNameConfigurationTask(ServerConfigurationPacketListenerImpl listener)
    implements ICustomConfigurationTask {
    static final ConfigurationTask.Type TYPE = new ConfigurationTask.Type(
        ResourceLocation.fromNamespaceAndPath(BweeepDisplayNameMod.MOD_ID, "choose_display_name")
    );

    @Override
    public void run(Consumer<CustomPacketPayload> sender) {
        BweeepServer.VerifiedIdentity identity = BweeepServer.getConfigurationIdentity(listener.getOwner().getId());
        if (identity == null) {
            listener.disconnect(Component.literal("붸에엡 런처 인증을 확인하지 못했습니다."));
            return;
        }
        if (identity.displayName() != null && DisplayNameRules.normalize(identity.displayName()) != null) {
            listener.finishCurrentTask(TYPE);
            return;
        }
        sender.accept(new OpenNameScreenPayload(1, listener.getOwner().getName()));
    }

    @Override
    public ConfigurationTask.Type type() {
        return TYPE;
    }
}
