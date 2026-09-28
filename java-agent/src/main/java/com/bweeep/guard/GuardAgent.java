package com.bweeep.guard;

import java.lang.instrument.Instrumentation;
import java.security.Security;

/**
 * Keeps a launcher-started Minecraft on the server the player picked, on any
 * Minecraft version and any loader. Every client since 1.7 opens server
 * connections through Netty's Bootstrap, so that one class is patched; the
 * patch only calls java.base, which every class loader and module can see.
 */
public final class GuardAgent {
    private GuardAgent() {
    }

    public static void premain(String args, Instrumentation instrumentation) {
        String target = System.getProperty("bweeep.targetServer", "").trim();
        if (target.isEmpty()) return;
        TargetPolicy policy;
        try {
            policy = TargetPolicy.parse(target);
        } catch (IllegalArgumentException error) {
            System.out.println("BWEEP_GUARD_DISABLED invalid target");
            return;
        }
        // Last in the list: it registers no algorithms, so no lookup ever lands on it.
        Security.addProvider(new GuardProvider(policy));
        instrumentation.addTransformer(new BootstrapTransformer(), true);
        for (Class<?> loaded : instrumentation.getAllLoadedClasses()) {
            if (BootstrapTransformer.TARGET.equals(loaded.getName().replace('.', '/'))) {
                try {
                    instrumentation.retransformClasses(loaded);
                } catch (Exception error) {
                    System.out.println("BWEEP_GUARD_DISABLED " + error);
                }
            }
        }
        System.out.println("BWEEP_GUARD_READY");
    }
}
