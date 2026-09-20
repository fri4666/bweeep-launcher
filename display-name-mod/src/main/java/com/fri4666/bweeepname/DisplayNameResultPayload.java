package com.fri4666.bweeepname;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

record DisplayNameResultPayload(boolean success, String displayName, String message)
    implements CustomPacketPayload {
    static final Type<DisplayNameResultPayload> TYPE = new Type<>(
        ResourceLocation.fromNamespaceAndPath(BweeepDisplayNameMod.MOD_ID, "display_name_result")
    );
    static final StreamCodec<ByteBuf, DisplayNameResultPayload> STREAM_CODEC = StreamCodec.of(
        (buffer, payload) -> {
            ByteBufCodecs.BOOL.encode(buffer, payload.success());
            ByteBufCodecs.stringUtf8(64).encode(buffer, payload.displayName());
            ByteBufCodecs.stringUtf8(256).encode(buffer, payload.message());
        },
        buffer -> new DisplayNameResultPayload(
            ByteBufCodecs.BOOL.decode(buffer),
            ByteBufCodecs.stringUtf8(64).decode(buffer),
            ByteBufCodecs.stringUtf8(256).decode(buffer)
        )
    );

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
