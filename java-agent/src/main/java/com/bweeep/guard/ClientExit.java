package com.bweeep.guard;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

/** Requests Minecraft's own render/audio shutdown, without linking to a loader. */
final class ClientExit {
    private static final String[][] CLIENTS = {
        { "net.minecraft.class_310", "method_1551", "method_1592" },
        { "net.minecraft.client.MinecraftClient", "getInstance", "scheduleStop" },
        { "net.minecraft.client.Minecraft", "getInstance", "stop" }
    };

    private ClientExit() { }

    static boolean requestStop(Instrumentation instrumentation) {
        // Fabric's client lives in Knot's loader, not the agent's system loader.
        // Inspect already loaded classes rather than loading/initializing another client.
        for (Class<?> type : instrumentation.getAllLoadedClasses()) {
            for (String[] names : CLIENTS) {
                if (!type.getName().equals(names[0])) continue;
                try {
                    Method getter = type.getMethod(names[1]);
                    Method stop = type.getMethod(names[2]);
                    if (!Modifier.isStatic(getter.getModifiers()) ||
                        !type.isAssignableFrom(getter.getReturnType()) ||
                        Modifier.isStatic(stop.getModifiers()) || stop.getReturnType() != Void.TYPE) continue;
                    Object client = getter.invoke(null);
                    if (client == null) continue;
                    stop.invoke(client);
                    return true;
                } catch (ReflectiveOperationException | SecurityException | LinkageError unavailable) {
                    // Older/unrecognized clients retain the original JVM-exit fallback.
                }
            }
        }
        return false;
    }
}
