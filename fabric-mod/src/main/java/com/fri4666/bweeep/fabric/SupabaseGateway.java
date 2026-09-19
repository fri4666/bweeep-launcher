package com.fri4666.bweeep.fabric;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

final class SupabaseGateway {
    private static final URI ENDPOINT = URI.create(
        "https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access"
    );
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    private SupabaseGateway() {}

    static CompletableFuture<VerifiedIdentity> consumeTicket(String ticket, String gameName) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "consumeGameTicket");
        body.addProperty("ticket", ticket);
        body.addProperty("gameName", gameName);
        return post(body).thenApply(response -> {
            if (response.statusCode() != 200) return null;
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            if (!json.has("ok") || !json.get("ok").getAsBoolean()) return null;
            String userId = string(json, "userId");
            String discordId = string(json, "discordId");
            String role = string(json, "role");
            String session = string(json, "displaySessionToken");
            String displayName = json.has("displayName") && !json.get("displayName").isJsonNull()
                ? json.get("displayName").getAsString()
                : null;
            if (!discordId.matches("\\d{15,22}") || !session.matches("[A-Za-z0-9_-]{43}")) return null;
            return new VerifiedIdentity(userId, discordId, role, session, displayName);
        });
    }

    static CompletableFuture<SaveResult> setDisplayName(String sessionToken, String displayName) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "setDisplayName");
        body.addProperty("sessionToken", sessionToken);
        body.addProperty("displayName", displayName);
        return post(body).thenApply(response -> {
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            if (response.statusCode() != 200 || !json.has("ok") || !json.get("ok").getAsBoolean()) {
                return new SaveResult(false, "", json.has("message")
                    ? json.get("message").getAsString()
                    : "서버 이름을 저장하지 못했습니다.");
            }
            return new SaveResult(true, string(json, "displayName"), "서버 이름이 저장되었습니다.");
        });
    }

    private static CompletableFuture<HttpResponse<String>> post(JsonObject body) {
        HttpRequest request = HttpRequest.newBuilder(ENDPOINT)
            .timeout(Duration.ofSeconds(8))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build();
        return HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString());
    }

    private static String string(JsonObject json, String key) {
        return json.has(key) ? json.get(key).getAsString() : "";
    }

    record VerifiedIdentity(String userId, String discordId, String role, String sessionToken, String displayName) {}
    record SaveResult(boolean success, String displayName, String message) {}
}
