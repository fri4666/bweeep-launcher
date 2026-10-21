package com.fri4666.bweeep.fabric;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import com.fri4666.bweeep.fabric.mixin.ServerCommonConnectionAccessor;
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
import net.minecraft.network.Connection;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
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
    private static final Map<ServerGamePacketListenerImpl, PendingAuth> PENDING_AUTH = new HashMap<>();
    private static final Map<ServerGamePacketListenerImpl, SupabaseGateway.VerifiedIdentity> VERIFIED = new HashMap<>();
    private static final ConnectionAuthStore<Connection, SupabaseGateway.VerifiedIdentity> CONFIGURATION_AUTH =
        new ConnectionAuthStore<>();

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
            CONFIGURATION_AUTH.begin(connection(handler));
            if (!ServerConfigurationNetworking.canSend(handler, BweeepProtocol.TicketRequest.TYPE)) {
                CONFIGURATION_AUTH.close(connection(handler));
                handler.disconnect(Component.literal("붸에엡 클라이언트 모드가 필요합니다."));
                return;
            }
            ((FabricServerConfigurationNetworkHandler) handler).addTask(new FabricConfigurationTask(handler));
        });
        ServerConfigurationConnectionEvents.DISCONNECT.register((handler, server) ->
            CONFIGURATION_AUTH.close(connection(handler))
        );
        ServerConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.GameTicket.TYPE, (payload, context) ->
            authenticateConfiguration(payload, context)
        );
        ServerConfigurationNetworking.registerGlobalReceiver(BweeepProtocol.SubmitName.TYPE, (payload, context) ->
            saveConfigurationName(payload, context)
        );

        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            ServerPlayer player = handler.player;
            server.getPlayerList().deop(player.getGameProfile());
            VERIFIED.remove(handler);
            SupabaseGateway.VerifiedIdentity configured = CONFIGURATION_AUTH.takeReady(connection(handler));
            if (configured != null) {
                VERIFIED.put(handler, configured);
                if ("admin".equals(configured.role())) server.getPlayerList().op(player.getGameProfile());
                DisplayNames.onAuthenticated(player, configured);
                return;
            }
            PENDING_AUTH.put(handler, new PendingAuth(server.getTickCount() + 200));
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            CONFIGURATION_AUTH.close(connection(handler));
            server.execute(() -> {
                ServerPlayer player = handler.player;
                PENDING_AUTH.remove(handler);
                VERIFIED.remove(handler);
                DisplayNames.onDisconnect(player);
                ServerPlayer current = server.getPlayerList().getPlayer(player.getUUID());
                if (current == null || current.connection == handler) server.getPlayerList().deop(player.getGameProfile());
            });
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            int tick = server.getTickCount();
            Iterator<Map.Entry<ServerGamePacketListenerImpl, PendingAuth>> iterator = PENDING_AUTH.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<ServerGamePacketListenerImpl, PendingAuth> entry = iterator.next();
                if (entry.getValue().deadline > tick) continue;
                iterator.remove();
                entry.getKey().disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
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
        return isActive(player.connection) && player.connection.player == player ? VERIFIED.get(player.connection) : null;
    }

    private static Connection connection(ServerCommonPacketListenerImpl handler) {
        return ((ServerCommonConnectionAccessor) handler).bweeep$connection();
    }

    private static boolean isActive(ServerGamePacketListenerImpl handler) {
        Connection connection = connection(handler);
        return connection.isConnected() && connection.getPacketListener() == handler
            && handler.player.getServer().getPlayerList().getPlayer(handler.player.getUUID()) == handler.player;
    }

    private static void authenticate(ServerPlayer player, String ticket) {
        ServerGamePacketListenerImpl handler = player.connection;
        PendingAuth pending = PENDING_AUTH.get(handler);
        if (!isActive(handler) || !ticket.matches("[A-Za-z0-9_-]{43}") || pending == null || pending.claimed) {
            PENDING_AUTH.remove(handler);
            player.connection.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
            return;
        }
        pending.claimed = true;
        SupabaseGateway.consumeTicket(ticket, player.getGameProfile().getName()).whenComplete((identity, error) ->
            player.getServer().execute(() -> {
                if (!isActive(handler) || PENDING_AUTH.get(handler) != pending) return;
                PENDING_AUTH.remove(handler);
                if (error != null || identity == null) {
                    handler.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
                    return;
                }
                VERIFIED.put(handler, identity);
                ServerPlayer current = handler.player;
                if ("admin".equals(identity.role())) current.getServer().getPlayerList().op(current.getGameProfile());
                DisplayNames.onAuthenticated(current, identity);
            })
        );
    }

    private static void authenticateConfiguration(
        BweeepProtocol.GameTicket payload,
        ServerConfigurationNetworking.Context context
    ) {
        var handler = context.networkHandler();
        Connection connection = connection(handler);
        if (!connection.isConnected() || connection.getPacketListener() != handler) return;
        var pending = CONFIGURATION_AUTH.claimTicket(connection);
        if (pending == null || !payload.ticket().matches("[A-Za-z0-9_-]{43}")) {
            CONFIGURATION_AUTH.close(connection);
            handler.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
            return;
        }
        SupabaseGateway.consumeTicket(payload.ticket(), handler.getOwner().getName()).whenComplete((identity, error) ->
            context.server().execute(() -> {
                if (!connection.isConnected() || connection.getPacketListener() != handler) {
                    CONFIGURATION_AUTH.close(connection, pending);
                    return;
                }
                if (error != null || identity == null) {
                    if (!CONFIGURATION_AUTH.close(connection, pending)) return;
                    handler.disconnect(Component.literal("붸에엡 런처 인증에 실패했습니다."));
                    return;
                }
                boolean needsName = identity.displayName() == null || DisplayNameRules.normalize(identity.displayName()) == null;
                if (!CONFIGURATION_AUTH.verified(connection, pending, identity, needsName)) return;
                if (!needsName) {
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
        Connection connection = connection(handler);
        if (!connection.isConnected() || connection.getPacketListener() != handler) return;
        String name = DisplayNameRules.normalize(payload.displayName());
        if (name == null) {
            ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                false, "", "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다."
            ));
            return;
        }
        var pending = CONFIGURATION_AUTH.claimName(connection);
        if (pending == null) return;
        SupabaseGateway.VerifiedIdentity identity = CONFIGURATION_AUTH.identity(connection, pending);
        if (identity == null) return;
        SupabaseGateway.setDisplayName(identity.sessionToken(), name).whenComplete((result, error) ->
            context.server().execute(() -> {
                if (!connection.isConnected() || connection.getPacketListener() != handler) {
                    CONFIGURATION_AUTH.close(connection, pending);
                    return;
                }
                if (error != null || result == null || !result.success()) {
                    if (!CONFIGURATION_AUTH.nameFailed(connection, pending)) return;
                    ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                        false, "", result == null ? "이름 저장에 실패했습니다. 다시 시도해 주세요." : result.message()
                    ));
                    return;
                }
                if (!CONFIGURATION_AUTH.nameSaved(connection, pending, new SupabaseGateway.VerifiedIdentity(
                    identity.userId(), identity.discordId(), identity.role(), identity.sessionToken(), result.displayName()
                ))) return;
                ServerConfigurationNetworking.send(handler, new BweeepProtocol.DisplayNameResult(
                    true, result.displayName(), "서버 이름이 저장되었습니다."
                ));
                ((FabricServerConfigurationNetworkHandler) handler).completeTask(FabricConfigurationTask.TYPE);
            })
        );
    }

    private static final class PendingAuth {
        private final int deadline;
        private boolean claimed;

        private PendingAuth(int deadline) { this.deadline = deadline; }
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
