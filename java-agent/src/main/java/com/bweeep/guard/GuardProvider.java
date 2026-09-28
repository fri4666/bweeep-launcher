package com.bweeep.guard;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.security.Provider;

/**
 * Reached from the patched Bootstrap through {@code Security.getProvider}, a
 * lookup every class can make. It registers no algorithms; {@link #get} is
 * only overridden for the two objects the patch passes in.
 */
final class GuardProvider extends Provider {
    static final String NAME = "BweeepGuard";
    private static final long serialVersionUID = 1L;

    private final transient TargetPolicy policy;
    /** Whether the connect call on this thread is to the selected server. */
    private final transient ThreadLocal<Boolean> targetConnect = new ThreadLocal<Boolean>();

    @SuppressWarnings("deprecation")
    GuardProvider(TargetPolicy policy) {
        super(NAME, 1.0, "Bweeep connection guard");
        this.policy = policy;
    }

    @Override
    public Object get(Object key) {
        if (key instanceof SocketAddress) {
            check((SocketAddress) key);
            return null;
        }
        if (key != null && implementsInterface(key.getClass(), "io.netty.channel.ChannelFuture")) {
            if (Boolean.TRUE.equals(targetConnect.get())) {
                targetConnect.remove();
                report(key);
            }
            return null;
        }
        return super.get(key);
    }

    private void check(SocketAddress address) {
        if (!(address instanceof InetSocketAddress)) return;
        InetSocketAddress inet = (InetSocketAddress) address;
        TargetPolicy.Decision decision = policy.decide(inet);
        if (decision == TargetPolicy.Decision.BLOCKED) {
            System.out.println("BWEEP_GUARD_BLOCKED " + inet.getHostString() + ":" + inet.getPort());
            throw new IllegalStateException("붸에엡 런처로 실행한 게임은 선택한 서버에만 접속할 수 있어요.");
        }
        if (decision == TargetPolicy.Decision.TARGET) targetConnect.set(Boolean.TRUE);
    }

    /** Prints the outcome of a connection to the selected server for the launcher to show. */
    private static void report(Object future) {
        try {
            ClassLoader loader = future.getClass().getClassLoader();
            final Class<?> listenerType = Class.forName("io.netty.util.concurrent.GenericFutureListener", false, loader);
            final Method addListener = future.getClass().getMethod("addListener", listenerType);
            addListener.invoke(future, listener(listenerType, new Outcome() {
                @Override
                public void done(Object connectFuture) throws Exception {
                    boolean success = (Boolean) connectFuture.getClass().getMethod("isSuccess").invoke(connectFuture);
                    if (!success) {
                        System.out.println("BWEEP_TARGET_UNREACHABLE");
                        return;
                    }
                    System.out.println("BWEEP_TARGET_CONNECTED");
                    Object channel = connectFuture.getClass().getMethod("channel").invoke(connectFuture);
                    Object closeFuture = channel.getClass().getMethod("closeFuture").invoke(channel);
                    closeFuture.getClass().getMethod("addListener", listenerType).invoke(closeFuture, listener(listenerType, new Outcome() {
                        @Override
                        public void done(Object ignored) {
                            System.out.println("BWEEP_TARGET_DISCONNECTED");
                        }
                    }));
                }
            }));
        } catch (Throwable error) {
            // Reporting is a convenience; the connection itself is unaffected.
        }
    }

    private interface Outcome {
        void done(Object future) throws Exception;
    }

    private static Object listener(Class<?> listenerType, final Outcome outcome) {
        return Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[] { listenerType }, new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                if (method.getName().equals("operationComplete") && args != null && args.length == 1) {
                    try {
                        outcome.done(args[0]);
                    } catch (Throwable ignored) {
                        // Never disturb Netty's event loop.
                    }
                    return null;
                }
                if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
                if (method.getName().equals("equals")) return proxy == args[0];
                if (method.getName().equals("toString")) return "BweeepGuardListener";
                return null;
            }
        });
    }

    private static boolean implementsInterface(Class<?> type, String name) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Class<?> implemented : current.getInterfaces()) {
                if (implemented.getName().equals(name) || implementsInterface(implemented, name)) return true;
            }
        }
        return false;
    }
}
