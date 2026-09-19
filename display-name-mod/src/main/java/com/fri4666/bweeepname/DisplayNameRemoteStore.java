package com.fri4666.bweeepname;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

final class DisplayNameRemoteStore {
    private static final URI ENDPOINT = URI.create(
        "https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access"
    );
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    private DisplayNameRemoteStore() {}

    static CompletableFuture<Result> setOnce(String sessionToken, String displayName) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "setDisplayName");
        body.addProperty("sessionToken", sessionToken);
        body.addProperty("displayName", displayName);
        HttpRequest request = HttpRequest.newBuilder(ENDPOINT)
            .timeout(Duration.ofSeconds(8))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build();
        return HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            if (response.statusCode() != 200 || !json.has("ok") || !json.get("ok").getAsBoolean()) {
                String message = json.has("message")
                    ? json.get("message").getAsString()
                    : "서버 이름을 저장하지 못했습니다.";
                return new Result(false, "", message);
            }
            String savedName = json.has("displayName") ? json.get("displayName").getAsString() : "";
            return new Result(true, savedName, "서버 이름이 저장되었습니다.");
        });
    }

    record Result(boolean success, String displayName, String message) {}
}
