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
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.network.chat.Component;
import net.minecraft.network.ConnectionProtocol;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.network.event.RegisterConfigurationTasksEvent;
import net.neoforged.neoforge.network.handling.IPayloadContext;

public final class BweeepServer {
    private static final String DISCORD_ID_DATA_KEY = "bweeep.discord_id";
    private static final Component AUTH_FAILED = Component.literal("붸에엡 런처 인증에 실패했습니다.");
    private static final URI TICKET_ENDPOINT = URI.create("https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access");
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final Map<UUID, Integer> PENDING = new HashMap<>();
    private static final Map<UUID, VerifiedIdentity> VERIFIED = new HashMap<>();
    private static final Map<UUID, VerifiedIdentity> CONFIGURATION_VERIFIED = new ConcurrentHashMap<>();

    private BweeepServer() {}

    static void onPlayerLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        player.getServer().getPlayerList().deop(player.getGameProfile());
        VERIFIED.remove(player.getUUID());
        VerifiedIdentity configured = CONFIGURATION_VERIFIED.remove(player.getUUID());
        if (configured != null) {
            finishAuthentication(player, configured, null, false);
            return;
        }
        PENDING.put(player.getUUID(), player.getServer().getTickCount() + 200);
    }

    static void onPlayerLogout(PlayerEvent.PlayerLoggedOutEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        PENDING.remove(player.getUUID());
        VERIFIED.remove(player.getUUID());
        player.getServer().getPlayerList().deop(player.getGameProfile());
    }

    static void handleTicket(GameTicketPayload payload, IPayloadContext context) {
        if (context.protocol() == ConnectionProtocol.CONFIGURATION) {
            handleConfigurationTicket(payload, context);
            return;
        }
        if (!(context.player() instanceof ServerPlayer player)) {
            context.disconnect(AUTH_FAILED);
            return;
        }
        if (!payload.ticket().matches("[A-Za-z0-9_-]{43}") || !PENDING.containsKey(player.getUUID())) {
            context.disconnect(AUTH_FAILED);
            return;
        }
        consumeTicket(payload.ticket(), player.getGameProfile().getName()).whenComplete((identity, error) ->
            player.getServer().execute(() -> finishAuthentication(player, identity, error, true))
        );
    }

    static void registerConfigurationTask(RegisterConfigurationTasksEvent event) {
        event.register(new BweeepAuthenticationTask());
    }

    private static void handleConfigurationTicket(GameTicketPayload payload, IPayloadContext context) {
        if (!(context.listener() instanceof ServerConfigurationPacketListenerImpl listener)
            || !payload.ticket().matches("[A-Za-z0-9_-]{43}")) {
            context.disconnect(AUTH_FAILED);
            return;
        }
        UUID profileId = listener.getOwner().getId();
        String gameName = listener.getOwner().getName();
        consumeTicket(payload.ticket(), gameName).whenComplete((identity, error) ->
            context.enqueueWork(() -> {
                if (error != null || identity == null) {
                    context.disconnect(AUTH_FAILED);
                    return;
                }
                CONFIGURATION_VERIFIED.put(profileId, identity);
                context.finishCurrentTask(BweeepAuthenticationTask.TYPE);
            })
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

    private static java.util.concurrent.CompletableFuture<VerifiedIdentity> consumeTicket(String ticket, String gameName) {
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
            String displaySessionToken = json.has("displaySessionToken")
                ? json.get("displaySessionToken").getAsString()
                : "";
            String displayName = json.has("displayName") && !json.get("displayName").isJsonNull()
                ? json.get("displayName").getAsString()
                : null;
            if (!discordId.matches("\\d{15,22}")) return null;
            if (!displaySessionToken.matches("[A-Za-z0-9_-]{43}")) return null;
            try {
                UUID.fromString(userId);
            } catch (IllegalArgumentException ignored) {
                return null;
            }
            return "admin".equals(role) || "member".equals(role)
                ? new VerifiedIdentity(userId, discordId, role, displaySessionToken, displayName)
                : null;
        });
    }

    private static void finishAuthentication(ServerPlayer player, VerifiedIdentity identity, Throwable error, boolean requirePending) {
        boolean pendingAccepted = !requirePending || PENDING.remove(player.getUUID()) != null;
        if (error != null || identity == null || !pendingAccepted || player.hasDisconnected()) {
            if (!player.hasDisconnected()) player.connection.disconnect(AUTH_FAILED);
            return;
        }
        player.getPersistentData().putString(DISCORD_ID_DATA_KEY, identity.discordId());
        VERIFIED.put(player.getUUID(), identity);
        if ("admin".equals(identity.role())) {
            player.getServer().getPlayerList().op(player.getGameProfile());
        } else {
            player.getServer().getPlayerList().deop(player.getGameProfile());
        }
    }

    public static VerifiedIdentity getVerifiedIdentity(ServerPlayer player) {
        return VERIFIED.get(player.getUUID());
    }

    public static VerifiedIdentity getConfigurationIdentity(UUID profileId) {
        return CONFIGURATION_VERIFIED.get(profileId);
    }

    public static void updateConfigurationDisplayName(UUID profileId, String displayName) {
        CONFIGURATION_VERIFIED.computeIfPresent(profileId, (ignored, identity) -> new VerifiedIdentity(
            identity.userId(),
            identity.discordId(),
            identity.role(),
            identity.displaySessionToken(),
            displayName
        ));
    }

    public record VerifiedIdentity(
        String userId,
        String discordId,
        String role,
        String displaySessionToken,
        String displayName
    ) {}
}
