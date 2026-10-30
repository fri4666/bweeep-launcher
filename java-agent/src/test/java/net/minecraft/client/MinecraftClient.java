package net.minecraft.client;

/** Client fixture: shutdown must run before JVM shutdown hooks. */
public final class MinecraftClient {
    private static final MinecraftClient INSTANCE = new MinecraftClient();
    public static volatile boolean stopRequested;
    public static MinecraftClient getInstance() { return INSTANCE; }
    public void scheduleStop() { stopRequested = true; }
}
