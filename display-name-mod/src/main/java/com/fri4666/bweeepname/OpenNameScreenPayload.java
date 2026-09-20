package com.fri4666.bweeepname;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

record OpenNameScreenPayload(int requestId, String gameName) implements CustomPacketPayload {
    static final Type<OpenNameScreenPayload> TYPE = new Type<>(
        ResourceLocation.fromNamespaceAndPath(BweeepDisplayNameMod.MOD_ID, "open_name_screen")
    );
    static final StreamCodec<ByteBuf, OpenNameScreenPayload> STREAM_CODEC = StreamCodec.of(
        (buffer, payload) -> {
            ByteBufCodecs.INT.encode(buffer, payload.requestId());
            ByteBufCodecs.stringUtf8(16).encode(buffer, payload.gameName());
        },
        buffer -> new OpenNameScreenPayload(
            ByteBufCodecs.INT.decode(buffer),
            ByteBufCodecs.stringUtf8(16).decode(buffer)
        )
    );

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
