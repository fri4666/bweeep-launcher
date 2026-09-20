package com.fri4666.bweeepname;

import com.fri4666.bweeep.BweeepServer;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.ChatFormatting;
import net.minecraft.network.ConnectionProtocol;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterConfigurationTasksEvent;
import net.neoforged.neoforge.network.handling.IPayloadContext;

final class DisplayNameServer {
    private static final Map<UUID, PendingGrant> PENDING_GRANTS = new HashMap<>();
    private static final Map<UUID, String> VISIBLE_NAMES = new HashMap<>();
    private static final Map<UUID, Boolean> SAVING = new HashMap<>();
    private static final Map<UUID, Boolean> CONFIGURATION_SAVING = new ConcurrentHashMap<>();

    private DisplayNameServer() {}

    static void onPlayerLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        int tick = player.getServer().getTickCount();
        VISIBLE_NAMES.remove(player.getUUID());
        SAVING.remove(player.getUUID());
        PENDING_GRANTS.put(player.getUUID(), new PendingGrant(tick + 20, tick + 600));
    }

    static void onPlayerLogout(PlayerEvent.PlayerLoggedOutEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        PENDING_GRANTS.remove(player.getUUID());
        VISIBLE_NAMES.remove(player.getUUID());
        SAVING.remove(player.getUUID());
    }

    static void onServerTick(ServerTickEvent.Post event) {
        int tick = event.getServer().getTickCount();
        Iterator<Map.Entry<UUID, PendingGrant>> pending = PENDING_GRANTS.entrySet().iterator();
        while (pending.hasNext()) {
            Map.Entry<UUID, PendingGrant> entry = pending.next();
            if (entry.getValue().nextAttemptTick() > tick) continue;
            ServerPlayer player = event.getServer().getPlayerList().getPlayer(entry.getKey());
            if (player == null) {
                pending.remove();
                continue;
            }
            BweeepServer.VerifiedIdentity identity = BweeepServer.getVerifiedIdentity(player);
            if (identity == null && tick < entry.getValue().deadlineTick()) {
                entry.setValue(new PendingGrant(tick + 20, entry.getValue().deadlineTick()));
                continue;
            }
            pending.remove();
            if (identity != null) grantTokenIfNeeded(player, identity);
        }
    }

    static void onNameFormat(PlayerEvent.NameFormat event) {
        String name = VISIBLE_NAMES.get(event.getEntity().getUUID());
        if (name != null) event.setDisplayname(Component.literal(name));
    }

    static void onTabListNameFormat(PlayerEvent.TabListNameFormat event) {
        String name = VISIBLE_NAMES.get(event.getEntity().getUUID());
        if (name != null) event.setDisplayName(Component.literal(name));
    }

    static void handleSubmission(SubmitNamePayload payload, IPayloadContext context) {
        if (context.protocol() == ConnectionProtocol.CONFIGURATION) {
            saveConfigurationSubmission(payload, context);
            return;
        }
        if (!(context.player() instanceof ServerPlayer player)) return;
        context.enqueueWork(() -> saveSubmission(player, payload.displayName()));
    }

    static void registerConfigurationTask(RegisterConfigurationTasksEvent event) {
        if (event.getListener() instanceof ServerConfigurationPacketListenerImpl listener) {
            event.register(new DisplayNameConfigurationTask(listener));
        }
    }

    private static void saveConfigurationSubmission(SubmitNamePayload payload, IPayloadContext context) {
        if (!(context.listener() instanceof ServerConfigurationPacketListenerImpl listener)) {
            context.disconnect(Component.literal("이름 설정 연결을 확인하지 못했습니다."));
            return;
        }
        UUID profileId = listener.getOwner().getId();
        String normalized = DisplayNameRules.normalize(payload.displayName());
        if (normalized == null) {
            context.reply(new DisplayNameResultPayload(false, "", "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다."));
            return;
        }
        BweeepServer.VerifiedIdentity identity = BweeepServer.getConfigurationIdentity(profileId);
        if (identity == null) {
            context.disconnect(Component.literal("런처 계정 인증을 확인하지 못했습니다."));
            return;
        }
        if (CONFIGURATION_SAVING.putIfAbsent(profileId, true) != null) return;
        DisplayNameRemoteStore.setOnce(identity.displaySessionToken(), normalized).whenComplete((result, error) ->
            context.enqueueWork(() -> finishConfigurationSave(context, profileId, result, error))
        );
    }

    private static void finishConfigurationSave(
        IPayloadContext context,
        UUID profileId,
        DisplayNameRemoteStore.Result result,
        Throwable error
    ) {
        CONFIGURATION_SAVING.remove(profileId);
        if (error != null || result == null || !result.success()) {
            String message = result == null ? "이름 저장에 실패했습니다. 다시 시도해 주세요." : result.message();
            context.reply(new DisplayNameResultPayload(false, "", message));
            return;
        }
        BweeepServer.updateConfigurationDisplayName(profileId, result.displayName());
        context.reply(new DisplayNameResultPayload(true, result.displayName(), "서버 이름이 저장되었습니다."));
        context.finishCurrentTask(DisplayNameConfigurationTask.TYPE);
    }

    private static void grantTokenIfNeeded(ServerPlayer player, BweeepServer.VerifiedIdentity identity) {
        if (identity.displayName() != null && DisplayNameRules.normalize(identity.displayName()) != null) {
            VISIBLE_NAMES.put(player.getUUID(), identity.displayName());
            removeAllTokens(player);
            applyVisibleName(player, identity.displayName());
            return;
        }
        if (hasToken(player)) return;
        ItemStack token = new ItemStack(BweeepDisplayNameMod.NAME_TOKEN.get());
        if (!player.getInventory().add(token)) player.drop(token, false);
        player.sendSystemMessage(Component.literal("서버에서 사용할 이름을 정하려면 지급된 이름 설정권을 사용하세요.")
            .withStyle(ChatFormatting.GOLD));
    }

    private static void saveSubmission(ServerPlayer player, String rawName) {
        String normalized = DisplayNameRules.normalize(rawName);
        if (normalized == null) {
            sendResult(player, false, "", "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다.");
            return;
        }
        if (!hasToken(player)) {
            sendResult(player, false, "", "사용할 수 있는 이름 설정권이 없습니다.");
            return;
        }
        BweeepServer.VerifiedIdentity identity = BweeepServer.getVerifiedIdentity(player);
        if (identity == null) {
            sendResult(player, false, "", "런처 계정 인증을 확인하지 못했습니다.");
            return;
        }
        if (SAVING.putIfAbsent(player.getUUID(), true) != null) return;
        DisplayNameRemoteStore.setOnce(identity.displaySessionToken(), normalized).whenComplete((result, error) ->
            player.getServer().execute(() -> finishSave(player, result, error))
        );
    }

    private static void finishSave(
        ServerPlayer player,
        DisplayNameRemoteStore.Result result,
        Throwable error
    ) {
        SAVING.remove(player.getUUID());
        if (player.hasDisconnected()) return;
        if (error != null || result == null || !result.success()) {
            String message = result == null ? "이름 저장에 실패했습니다. 등록권은 그대로 유지됩니다." : result.message();
            sendResult(player, false, "", message);
            return;
        }
        removeAllTokens(player);
        VISIBLE_NAMES.put(player.getUUID(), result.displayName());
        applyVisibleName(player, result.displayName());
        sendResult(player, true, result.displayName(), "서버 이름이 저장되었습니다.");
    }

    private static void sendResult(ServerPlayer player, boolean success, String name, String message) {
        PacketDistributor.sendToPlayer(player, new DisplayNameResultPayload(success, name, message));
    }

    private static boolean hasToken(ServerPlayer player) {
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            if (player.getInventory().getItem(slot).is(BweeepDisplayNameMod.NAME_TOKEN.get())) return true;
        }
        return false;
    }

    private static void removeAllTokens(ServerPlayer player) {
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.is(BweeepDisplayNameMod.NAME_TOKEN.get())) player.getInventory().setItem(slot, ItemStack.EMPTY);
        }
        player.getInventory().setChanged();
    }

    private static void applyVisibleName(ServerPlayer player, String name) {
        player.setCustomName(Component.literal(name));
        player.setCustomNameVisible(true);
        player.refreshTabListName();
    }

    private record PendingGrant(int nextAttemptTick, int deadlineTick) {}
}
