package net.minecraft;

/** Client fixture: shutdown must run before JVM shutdown hooks. */
public final class class_310 {
    private static final class_310 INSTANCE = new class_310();
    public static volatile boolean stopRequested;
    public static class_310 method_1551() { return INSTANCE; }
    public void method_1592() { stopRequested = true; }
}
