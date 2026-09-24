package com.fri4666.bweeep.auth;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntSupplier;
import net.minecraft.network.Connection;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.event.entity.player.PlayerNegotiationEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.network.HandshakeHandler;
import net.minecraftforge.network.NetworkDirection;
import net.minecraftforge.network.NetworkEvent;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.simple.SimpleChannel;

@Mod(BweeepServerAuth.MOD_ID)
public final class BweeepServerAuth {
    public static final String MOD_ID = "bweeep_server_auth";
    private static final String VERSION = "1";
    private static final Component AUTH_FAILED = Component.literal("런처 인증에 실패했습니다.");
    private static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
        new ResourceLocation(MOD_ID, "login"),
        () -> VERSION,
        VERSION::equals,
        VERSION::equals
    );
    private static final Map<Connection, Pending> PENDING = new ConcurrentHashMap<>();
    private static final Set<Connection> VERIFIED = ConcurrentHashMap.newKeySet();

    public BweeepServerAuth() {
        CHANNEL.messageBuilder(LoginQuery.class, 0, NetworkDirection.LOGIN_TO_CLIENT)
            .encoder((message, buffer) -> {})
            .decoder(buffer -> new LoginQuery())
            .loginIndex(LoginQuery::getAsInt, LoginQuery::setIndex)
            .markAsLoginPacket()
            .consumerNetworkThread(BweeepServerAuth::handleQuery)
            .add();
        CHANNEL.messageBuilder(LoginAnswer.class, 1, NetworkDirection.LOGIN_TO_SERVER)
            .encoder((message, buffer) -> buffer.writeUtf(message.ticket, 64))
            .decoder(buffer -> new LoginAnswer(buffer.readUtf(64)))
            .loginIndex(LoginAnswer::getAsInt, LoginAnswer::setIndex)
            .consumerNetworkThread(HandshakeHandler.indexFirst((handshake, message, context) ->
                handleAnswer(message, context.get())))
            .add();
        MinecraftForge.EVENT_BUS.addListener(BweeepServerAuth::onNegotiation);
        MinecraftForge.EVENT_BUS.addListener(BweeepServerAuth::onPlayerLogin);
    }

    private static void onNegotiation(PlayerNegotiationEvent event) {
        Connection connection = event.getConnection();
        String gameName = event.getProfile().getName();
        Pending pending = new Pending(gameName);
        PENDING.put(connection, pending);
        event.enqueueWork(pending.gate);
        connection.channel().closeFuture().addListener(ignored -> {
            PENDING.remove(connection);
            VERIFIED.remove(connection);
            pending.gate.complete(null);
        });
    }

    private static void handleQuery(LoginQuery query, java.util.function.Supplier<NetworkEvent.Context> supplier) {
        NetworkEvent.Context context = supplier.get();
        String ticket = System.getenv("BWEEP_GAME_TICKET");
        if (ticket == null || !ticket.matches("[A-Za-z0-9_-]{43}")) {
            context.getNetworkManager().disconnect(AUTH_FAILED);
        } else {
            CHANNEL.reply(new LoginAnswer(ticket), context);
        }
        context.setPacketHandled(true);
    }

    private static void handleAnswer(LoginAnswer answer, NetworkEvent.Context context) {
        Connection connection = context.getNetworkManager();
        Pending pending = PENDING.get(connection);
        context.setPacketHandled(true);
        if (pending == null || !pending.claimed.compareAndSet(false, true)
                || !answer.ticket.matches("[A-Za-z0-9_-]{43}")
                || pending.gameName == null || !pending.gameName.matches("[A-Za-z0-9_]{3,16}")) {
            fail(connection, pending);
            return;
        }
        TicketVerifier.consume(answer.ticket, pending.gameName).whenComplete((valid, error) ->
            connection.channel().eventLoop().execute(() -> {
                if (!connection.isConnected()) {
                    pending.gate.complete(null);
                    return;
                }
                if (error != null || !Boolean.TRUE.equals(valid)) {
                    fail(connection, pending);
                    return;
                }
                VERIFIED.add(connection);
                PENDING.remove(connection, pending);
                pending.gate.complete(null);
            })
        );
    }

    private static void fail(Connection connection, Pending pending) {
        connection.disconnect(AUTH_FAILED);
        if (pending != null) {
            PENDING.remove(connection, pending);
            pending.gate.complete(null);
        }
    }

    private static void onPlayerLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof net.minecraft.server.level.ServerPlayer player)) return;
        Connection connection = player.connection.connection;
        if (!VERIFIED.remove(connection)) {
            connection.disconnect(AUTH_FAILED);
        }
    }

    public static final class LoginQuery implements IntSupplier {
        private int index;
        public LoginQuery() {}
        public int getAsInt() { return index; }
        public void setIndex(int index) { this.index = index; }
    }

    public static final class LoginAnswer implements IntSupplier {
        private final String ticket;
        private int index;
        public LoginAnswer(String ticket) { this.ticket = ticket; }
        public int getAsInt() { return index; }
        public void setIndex(int index) { this.index = index; }
    }

    private static final class Pending {
        private final String gameName;
        private final CompletableFuture<Void> gate = new CompletableFuture<>();
        private final AtomicBoolean claimed = new AtomicBoolean();
        private Pending(String gameName) { this.gameName = gameName; }
    }

    private static final class TicketVerifier {
        private static final URI DEFAULT_ENDPOINT = URI.create(
            "https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access"
        );
        private static final URI ENDPOINT = endpoint();
        private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

        private static URI endpoint() {
            String configured = System.getenv("BWEEP_GAME_TICKET_ENDPOINT");
            if (configured == null || configured.isBlank()) return DEFAULT_ENDPOINT;
            URI uri = URI.create(configured);
            boolean loopbackHttp = "http".equals(uri.getScheme())
                && ("127.0.0.1".equals(uri.getHost()) || "::1".equals(uri.getHost()))
                && uri.getPort() > 0;
            if ((!DEFAULT_ENDPOINT.equals(uri) && !loopbackHttp)
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null) {
                throw new IllegalArgumentException("Unsupported Bweeep ticket endpoint");
            }
            return uri;
        }

        private static CompletableFuture<Boolean> consume(String ticket, String gameName) {
            JsonObject body = new JsonObject();
            body.addProperty("action", "consumeGameTicket");
            body.addProperty("ticket", ticket);
            body.addProperty("gameName", gameName);
            HttpRequest request = HttpRequest.newBuilder(ENDPOINT)
                .timeout(Duration.ofSeconds(8))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();
            return HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
                if (response.statusCode() != 200) return false;
                JsonObject data = JsonParser.parseString(response.body()).getAsJsonObject();
                if (!data.has("ok") || !data.get("ok").getAsBoolean()) return false;
                String userId = data.has("userId") ? data.get("userId").getAsString() : "";
                String discordId = data.has("discordId") ? data.get("discordId").getAsString() : "";
                String role = data.has("role") ? data.get("role").getAsString() : "";
                try {
                    UUID.fromString(userId);
                } catch (IllegalArgumentException error) {
                    return false;
                }
                return discordId.matches("\\d{15,22}")
                    && ("admin".equals(role) || "member".equals(role));
            });
        }
    }
}
