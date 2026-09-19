package com.fri4666.bweeep.fabric;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.FabricServerConfigurationNetworkHandler;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerConfigurationConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerConfigurationNetworking;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResultHolder;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;

public final class BweeepFabric implements ModInitializer {
    static final String MOD_ID = "bweeep_client";
    static final Item NAME_TOKEN = Registry.register(
        BuiltInRegistries.ITEM,
        ResourceLocation.fromNamespaceAndPath(MOD_ID, "name_token"),
        new NameTokenItem(new Item.Properties().stacksTo(1))
    );
    private static final Map<UUID, Integer> PENDING_AUTH = new HashMap<>();
    private static final Map<UUID, SupabaseGateway.VerifiedIdentity> VERIFIED = new HashMap<>();
    private static final Map<UUID, SupabaseGateway.VerifiedIdentity> CONFIGURATION_VERIFIED = new ConcurrentHashMap<>();
    private static final Map<UUID, Boolean> CONFIGURATION_SAVING = new ConcurrentHashMap<>();

    @Override
    public void onInitialize() {
        PayloadTypeRegistry.playC2S().register(BweeepProtocol.GameTicket.TYPE, BweeepProtocol.GameTicket.CODEC);
        PayloadTypeRegistry.playC2S().register(BweeepProtocol.SubmitName.TYPE, BweeepProtocol.SubmitName.CODEC);
        PayloadTypeRegistry.playS2C().register(BweeepProtocol.OpenNameScreen.TYPE, BweeepProtocol.OpenNameScreen.CODEC);
        PayloadTypeRegistry.playS2C().register(BweeepProtocol.DisplayNameResult.TYPE, BweeepProtocol.DisplayNameResult.CODEC);
        PayloadTypeRegistry.configurationC2S().register(BweeepProtocol.GameTicket.TYPE, BweeepProtocol.GameTicket.CODEC);
        PayloadTypeRegistry.configurationC2S().register(BweeepProtocol.SubmitName.TYPE, BweeepProtocol.SubmitName.CODEC);
        PayloadTypeRegistry.configurationS2C().register(BweeepProtocol.TicketRequest.TYPE, BweeepProtocol.TicketRequest.CODEC);
        PayloadTypeRegistry.configurationS2C().register(BweeepProtocol.OpenNameScreen.TYPE, BweeepProtocol.OpenNameScreen.CODEC);
        PayloadTypeRegistry.configurationS2C().register(BweeepProtocol.DisplayNameResult.TYPE, BweeepProtocol.DisplayNameResult.CODEC);

        ServerConfigurationConnectionEvents.CONFIGURE.register((handler, server) -> {
            if (!ServerConfigurationNetworking.canSend(handler, BweeepProtocol.TicketRequest.TYPE)) {
                handler.disconnect(Component.literal("붸에엡 클라이언트 모드가 필요합니다."));
                return;
            }
            ((FabricServerConfigurationNetworkHandler) handler).addTask(new FabricConfigurationTask(handler));
        });
        ServerConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.GameTicket.TYPE, (payload, context) ->
            authenticateConfiguration(payload, context)
        );
        ServerConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.SubmitName.TYPE, (payload, context) ->
            saveConfigurationName(payload, context)
        );

        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            ServerPlayer player = handler.player;
            server.getPlayerList().deop(player.getGameProfile());
            VERIFIED.remove(player.getUUID());
            SupabaseGateway.VerifiedIdentity configured = CONFIGURATION_VERIFIED.remove(player.getUUID());
            if (configured != null) {
                VERIFIED.put(player.getUUID(), configured);
                if ("admin".equals(configured.role())) server.getPlayerList().op(player.getGameProfile());
                DisplayNames.onAuthenticated(player, configured);
                return;
            }
            PENDING_AUTH.put(player.getUUID(), server.getTickCount() + 200);
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            ServerPlayer player = handler.player;
            PENDING_AUTH.remove(player.getUUID());
            VERIFIED.remove(player.getUUID());
            DisplayNames.onDisconnect(player);
            server.getPlayerList().deop(player.getGameProfile());
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            int tick = server.getTickCount();
            Iterator<Map.Entry<UUID, Integer>> iterator = PENDING_AUTH.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<UUID, Integer> entry = iterator.next();
                if (entry.getValue() > tick) continue;
                iterator.remove();
                ServerPlayer player = server.getPlayerList().getPlayer(entry.getKey());
                if (player != null) player.connection.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
            }
        });
        ServerPlayNetworking.registerGlobalReceiver(BweeepProtocol.GameTicket.TYPE, (payload, context) ->
            context.server().execute(() -> authenticate(context.player(), payload.ticket()))
        );
        ServerPlayNetworking.registerGlobalReceiver(BweeepProtocol.SubmitName.TYPE, (payload, context) ->
            context.server().execute(() -> DisplayNames.submit(context.player(), payload.displayName()))
        );
    }

    static SupabaseGateway.VerifiedIdentity identity(ServerPlayer player) {
        return VERIFIED.get(player.getUUID());
    }

    private static void authenticate(ServerPlayer player, String ticket) {
        if (!ticket.matches("[A-Za-z0-9_-]{43}") || !PENDING_AUTH.containsKey(player.getUUID())) {
            player.connection.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
            return;
        }
        SupabaseGateway.consumeTicket(ticket, player.getGameProfile().getName()).whenComplete((identity, error) ->
            player.getServer().execute(() -> {
                if (error != null || identity == null || PENDING_AUTH.remove(player.getUUID()) == null) {
                    player.connection.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
                    return;
                }
                VERIFIED.put(player.getUUID(), identity);
                if ("admin".equals(identity.role())) player.getServer().getPlayerList().op(player.getGameProfile());
                DisplayNames.onAuthenticated(player, identity);
            })
        );
    }

    private static void authenticateConfiguration(
        BweeepProtocol.GameTicket payload,
        ServerConfigurationNetworking.Context context
    ) {
        var handler = context.networkHandler();
        if (!payload.ticket().matches("[A-Za-z0-9_-]{43}")) {
            handler.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
            return;
        }
        UUID profileId = handler.getOwner().getId();
        SupabaseGateway.consumeTicket(payload.ticket(), handler.getOwner().getName()).whenComplete((identity, error) ->
            context.server().execute(() -> {
                if (error != null || identity == null) {
                    handler.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
                    return;
                }
                CONFIGURATION_VERIFIED.put(profileId, identity);
                if (identity.displayName() != null && DisplayNameRules.normalize(identity.displayName()) != null) {
                    ((FabricServerConfigurationNetworkHandler) handler).completeTask(FabricConfigurationTask.TYPE);
                } else {
                    ServerConfigurationNetworking.send(handler, new BweeepProtocol.OpenNameScreen(1, handler.getOwner().getName()));
                }
            })
        );
    }

    private static void saveConfigurationName(
        BweeepProtocol.SubmitName payload,
        ServerConfigurationNetworking.Context context
    ) {
        var handler = context.networkHandler();
        UUID profileId = handler.getOwner().getId();
        String name = DisplayNameRules.normalize(payload.displayName());
        if (name == null) {
            ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                false, "", "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다."
            ));
            return;
        }
        SupabaseGateway.VerifiedIdentity identity = CONFIGURATION_VERIFIED.get(profileId);
        if (identity == null || CONFIGURATION_SAVING.putIfAbsent(profileId, true) != null) return;
        SupabaseGateway.setDisplayName(identity.sessionToken(), name).whenComplete((result, error) ->
            context.server().execute(() -> {
                CONFIGURATION_SAVING.remove(profileId);
                if (error != null || result == null || !result.success()) {
                    ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                        false, "", result == null ? "이름 저장에 실패했습니다. 다시 시도해 주세요." : result.message()
                    ));
                    return;
                }
                CONFIGURATION_VERIFIED.put(profileId, new SupabaseGateway.VerifiedIdentity(
                    identity.userId(), identity.discordId(), identity.role(), identity.sessionToken(), result.displayName()
                ));
                ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                    true, result.displayName(), "서버 이름이 저장되었습니다."
                ));
                ((FabricServerConfigurationNetworkHandler) handler).completeTask(FabricConfigurationTask.TYPE);
            })
        );
    }

    private static final class NameTokenItem extends Item {
        private NameTokenItem(Properties properties) { super(properties); }

        @Override
        public InteractionResultHolder<ItemStack> use(Level level, Player player, InteractionHand hand) {
            ItemStack stack = player.getItemInHand(hand);
            if (!level.isClientSide && player instanceof ServerPlayer serverPlayer) {
                ServerPlayNetworking.send(serverPlayer, new BweeepProtocol.OpenNameScreen(
                    serverPlayer.tickCount,
                    serverPlayer.getGameProfile().getName()
                ));
            }
            return InteractionResultHolder.sidedSuccess(stack, level.isClientSide);
        }
    }
}
