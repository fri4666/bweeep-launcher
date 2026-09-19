package com.fri4666.bweeep.fabric;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

final class BweeepProtocol {
    private BweeepProtocol() {}

    record GameTicket(String ticket) implements CustomPacketPayload {
        static final Type<GameTicket> TYPE = new Type<>(id("game_ticket"));
        static final StreamCodec<ByteBuf, GameTicket> CODEC = StreamCodec.composite(
            ByteBufCodecs.stringUtf8(4096), GameTicket::ticket, GameTicket::new
        );
        @Override public Type<? extends CustomPacketPayload> type() { return TYPE; }
    }

    record TicketRequest() implements CustomPacketPayload {
        static final TicketRequest INSTANCE = new TicketRequest();
        static final Type<TicketRequest> TYPE = new Type<>(id("ticket_request"));
        static final StreamCodec<ByteBuf, TicketRequest> CODEC = StreamCodec.unit(INSTANCE);
        @Override public Type<? extends CustomPacketPayload> type() { return TYPE; }
    }

    record OpenNameScreen(int requestId, String gameName) implements CustomPacketPayload {
        static final Type<OpenNameScreen> TYPE = new Type<>(id("open_name_screen"));
        static final StreamCodec<ByteBuf, OpenNameScreen> CODEC = StreamCodec.of(
            (buffer, payload) -> {
                ByteBufCodecs.INT.encode(buffer, payload.requestId());
                ByteBufCodecs.stringUtf8(16).encode(buffer, payload.gameName());
            },
            buffer -> new OpenNameScreen(
                ByteBufCodecs.INT.decode(buffer),
                ByteBufCodecs.stringUtf8(16).decode(buffer)
            )
        );
        @Override public Type<? extends CustomPacketPayload> type() { return TYPE; }
    }

    record SubmitName(String displayName) implements CustomPacketPayload {
        static final Type<SubmitName> TYPE = new Type<>(id("submit_name"));
        static final StreamCodec<ByteBuf, SubmitName> CODEC = StreamCodec.composite(
            ByteBufCodecs.stringUtf8(64), SubmitName::displayName, SubmitName::new
        );
        @Override public Type<? extends CustomPacketPayload> type() { return TYPE; }
    }

    record DisplayNameResult(boolean success, String displayName, String message)
        implements CustomPacketPayload {
        static final Type<DisplayNameResult> TYPE = new Type<>(id("display_name_result"));
        static final StreamCodec<ByteBuf, DisplayNameResult> CODEC = StreamCodec.of(
            (buffer, payload) -> {
                ByteBufCodecs.BOOL.encode(buffer, payload.success());
                ByteBufCodecs.stringUtf8(64).encode(buffer, payload.displayName());
                ByteBufCodecs.stringUtf8(256).encode(buffer, payload.message());
            },
            buffer -> new DisplayNameResult(
                ByteBufCodecs.BOOL.decode(buffer),
                ByteBufCodecs.stringUtf8(64).decode(buffer),
                ByteBufCodecs.stringUtf8(256).decode(buffer)
            )
        );
        @Override public Type<? extends CustomPacketPayload> type() { return TYPE; }
    }

    private static ResourceLocation id(String path) {
        return ResourceLocation.fromNamespaceAndPath(BweeepFabric.MOD_ID, path);
    }
}
