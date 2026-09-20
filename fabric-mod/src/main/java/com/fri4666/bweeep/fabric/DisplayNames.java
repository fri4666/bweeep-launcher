package com.fri4666.bweeep.fabric;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;

public final class DisplayNames {
    private static final Map<UUID, String> VISIBLE_NAMES = new HashMap<>();
    private static final Map<UUID, Boolean> SAVING = new HashMap<>();

    private DisplayNames() {}

    static void onAuthenticated(ServerPlayer player, SupabaseGateway.VerifiedIdentity identity) {
        if (identity.displayName() != null && DisplayNameRules.normalize(identity.displayName()) != null) {
            removeTokens(player);
            apply(player, identity.displayName());
            return;
        }
        if (!hasToken(player)) {
            ItemStack token = new ItemStack(BweeepFabric.NAME_TOKEN);
            if (!player.getInventory().add(token)) player.drop(token, false);
            player.sendSystemMessage(Component.literal("서버에서 사용할 이름을 정하려면 지급된 이름 설정권을 사용하세요."));
        }
    }

    static void onDisconnect(ServerPlayer player) {
        VISIBLE_NAMES.remove(player.getUUID());
        SAVING.remove(player.getUUID());
    }

    static void submit(ServerPlayer player, String rawName) {
        String name = DisplayNameRules.normalize(rawName);
        if (name == null) {
            send(player, false, "", "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다.");
            return;
        }
        if (!hasToken(player)) {
            send(player, false, "", "사용할 수 있는 이름 설정권이 없습니다.");
            return;
        }
        SupabaseGateway.VerifiedIdentity identity = BweeepFabric.identity(player);
        if (identity == null) {
            send(player, false, "", "런처 계정 인증을 확인하지 못했습니다.");
            return;
        }
        if (SAVING.putIfAbsent(player.getUUID(), true) != null) return;
        SupabaseGateway.setDisplayName(identity.sessionToken(), name).whenComplete((result, error) ->
            player.getServer().execute(() -> finish(player, result, error))
        );
    }

    public static String visibleName(ServerPlayer player) {
        return VISIBLE_NAMES.get(player.getUUID());
    }

    private static void finish(ServerPlayer player, SupabaseGateway.SaveResult result, Throwable error) {
        SAVING.remove(player.getUUID());
        if (error != null || result == null || !result.success()) {
            send(player, false, "", result == null
                ? "이름 저장에 실패했습니다. 등록권은 그대로 유지됩니다."
                : result.message());
            return;
        }
        removeTokens(player);
        apply(player, result.displayName());
        send(player, true, result.displayName(), "서버 이름이 저장되었습니다.");
    }

    private static void apply(ServerPlayer player, String name) {
        VISIBLE_NAMES.put(player.getUUID(), name);
        player.setCustomName(Component.literal(name));
        player.setCustomNameVisible(true);
    }

    private static boolean hasToken(ServerPlayer player) {
        for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
            if (player.getInventory().getItem(i).is(BweeepFabric.NAME_TOKEN)) return true;
        }
        return false;
    }

    private static void removeTokens(ServerPlayer player) {
        for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
            if (player.getInventory().getItem(i).is(BweeepFabric.NAME_TOKEN)) {
                player.getInventory().setItem(i, ItemStack.EMPTY);
            }
        }
        player.getInventory().setChanged();
    }

    private static void send(ServerPlayer player, boolean success, String name, String message) {
        ServerPlayNetworking.send(player, new BweeepProtocol.DisplayNameResult(success, name, message));
    }
}
