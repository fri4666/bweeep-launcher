package com.fri4666.bweeep;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.network.handling.IPayloadContext;

final class BweeepServer {
    private static final Component AUTH_FAILED = Component.literal("붸에엡 런처 인증에 실패했습니다.");
    private static final URI TICKET_ENDPOINT = URI.create("https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access");
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final Map<UUID, Integer> PENDING = new HashMap<>();

    private BweeepServer() {}

    static void onPlayerLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        player.getServer().getPlayerList().deop(player.getGameProfile());
        PENDING.put(player.getUUID(), player.getServer().getTickCount() + 200);
    }

    static void onPlayerLogout(PlayerEvent.PlayerLoggedOutEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        PENDING.remove(player.getUUID());
        player.getServer().getPlayerList().deop(player.getGameProfile());
    }

    static void handleTicket(GameTicketPayload payload, IPayloadContext context) {
        if (!(context.player() instanceof ServerPlayer player)) {
            context.disconnect(AUTH_FAILED);
            return;
        }
        if (!payload.ticket().matches("[A-Za-z0-9_-]{43}") || !PENDING.containsKey(player.getUUID())) {
            context.disconnect(AUTH_FAILED);
            return;
        }
        consumeTicket(payload.ticket(), player.getGameProfile().getName()).whenComplete((role, error) ->
            player.getServer().execute(() -> finishAuthentication(player, role, error))
        );
    }

    static void onServerTick(ServerTickEvent.Post event) {
        int tick = event.getServer().getTickCount();
        Iterator<Map.Entry<UUID, Integer>> pending = PENDING.entrySet().iterator();
        while (pending.hasNext()) {
            Map.Entry<UUID, Integer> entry = pending.next();
            if (entry.getValue() > tick) continue;
            ServerPlayer player = event.getServer().getPlayerList().getPlayer(entry.getKey());
            pending.remove();
            if (player != null) player.connection.disconnect(AUTH_FAILED);
        }
    }

    private static java.util.concurrent.CompletableFuture<String> consumeTicket(String ticket, String gameName) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "consumeGameTicket");
        body.addProperty("ticket", ticket);
        body.addProperty("gameName", gameName);
        HttpRequest request = HttpRequest.newBuilder(TICKET_ENDPOINT)
            .timeout(Duration.ofSeconds(8))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build();
        return HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() != 200) return null;
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            if (!json.has("ok") || !json.get("ok").getAsBoolean()) return null;
            String discordId = json.has("discordId") ? json.get("discordId").getAsString() : "";
            String userId = json.has("userId") ? json.get("userId").getAsString() : "";
            String role = json.has("role") ? json.get("role").getAsString() : "";
            if (!discordId.matches("\\d{15,22}")) return null;
            try {
                UUID.fromString(userId);
            } catch (IllegalArgumentException ignored) {
                return null;
            }
            return "admin".equals(role) || "member".equals(role) ? role : null;
        });
    }

    private static void finishAuthentication(ServerPlayer player, String role, Throwable error) {
        if (error != null || role == null || PENDING.remove(player.getUUID()) == null || player.hasDisconnected()) {
            if (!player.hasDisconnected()) player.connection.disconnect(AUTH_FAILED);
            return;
        }
        if ("admin".equals(role)) {
            player.getServer().getPlayerList().op(player.getGameProfile());
        } else {
            player.getServer().getPlayerList().deop(player.getGameProfile());
        }
    }
}
