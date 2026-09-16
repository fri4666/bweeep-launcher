package com.fri4666.bweeep;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

public record GameTicketPayload(String ticket) implements CustomPacketPayload {
    public static final Type<GameTicketPayload> TYPE = new Type<>(
        ResourceLocation.fromNamespaceAndPath(BweeepMod.MOD_ID, "game_ticket")
    );
    public static final StreamCodec<RegistryFriendlyByteBuf, GameTicketPayload> STREAM_CODEC = StreamCodec.composite(
        ByteBufCodecs.stringUtf8(4096), GameTicketPayload::ticket,
        GameTicketPayload::new
    );

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
