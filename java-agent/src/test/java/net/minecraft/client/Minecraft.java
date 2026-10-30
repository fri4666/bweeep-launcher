package net.minecraft.client;

/** Client fixture: shutdown must run before JVM shutdown hooks. */
public final class Minecraft {
    private static final Minecraft INSTANCE = new Minecraft();
    public static volatile boolean stopRequested;
    public static Minecraft getInstance() { return INSTANCE; }
    public void stop() { stopRequested = true; }
}
