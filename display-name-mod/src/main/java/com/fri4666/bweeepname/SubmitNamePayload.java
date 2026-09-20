package com.fri4666.bweeepname;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

record SubmitNamePayload(String displayName) implements CustomPacketPayload {
    static final Type<SubmitNamePayload> TYPE = new Type<>(
        ResourceLocation.fromNamespaceAndPath(BweeepDisplayNameMod.MOD_ID, "submit_name")
    );
    static final StreamCodec<ByteBuf, SubmitNamePayload> STREAM_CODEC = StreamCodec.composite(
        ByteBufCodecs.stringUtf8(64), SubmitNamePayload::displayName,
        SubmitNamePayload::new
    );

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
