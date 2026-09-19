package com.fri4666.bweeep;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

public record TicketRequestPayload() implements CustomPacketPayload {
    public static final TicketRequestPayload INSTANCE = new TicketRequestPayload();
    public static final Type<TicketRequestPayload> TYPE = new Type<>(
        ResourceLocation.fromNamespaceAndPath(BweeepMod.MOD_ID, "ticket_request")
    );
    public static final StreamCodec<ByteBuf, TicketRequestPayload> STREAM_CODEC = StreamCodec.unit(INSTANCE);

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
