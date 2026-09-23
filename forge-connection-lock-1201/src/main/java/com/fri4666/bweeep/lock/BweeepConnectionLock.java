package com.fri4666.bweeep.lock;

import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraftforge.client.event.ClientPlayerNetworkEvent;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.Mod;

@Mod(BweeepConnectionLock.MOD_ID)
public final class BweeepConnectionLock {
    public static final String MOD_ID = "bweeep_connection_lock";
    private static final String TARGET_PROPERTY = "bweeep.targetServer";
    private static final String JOINED_MARKER = "BWEEP_TARGET_JOINED";
    private static final String LEFT_MARKER = "BWEEP_TARGET_LEFT";
    private static final String REJECTED_MARKER = "BWEEP_TARGET_REJECTED";

    private final Target target = Target.parse(System.getProperty(TARGET_PROPERTY, ""));
    private static volatile boolean approvedAttempt;
    private boolean joinedTarget;
    private boolean stopping;

    public BweeepConnectionLock() {
        MinecraftForge.EVENT_BUS.addListener(this::onScreenOpening);
        MinecraftForge.EVENT_BUS.addListener(this::onLoggingIn);
        MinecraftForge.EVENT_BUS.addListener(this::onLoggingOut);
    }

    private void onScreenOpening(ScreenEvent.Opening event) {
        var screen = event.getNewScreen();
        if (((joinedTarget || approvedAttempt) && screen instanceof TitleScreen)
                || screen instanceof JoinMultiplayerScreen
                || screen instanceof SelectWorldScreen
                || screen instanceof DisconnectedScreen) {
            if (approvedAttempt && !joinedTarget && (screen instanceof DisconnectedScreen || screen instanceof TitleScreen)) {
                System.out.println(REJECTED_MARKER);
            }
            if (joinedTarget) markLeft();
            stop();
        }
    }

    private void onLoggingIn(ClientPlayerNetworkEvent.LoggingIn event) {
        ServerData selected = Minecraft.getInstance().getCurrentServer();
        if (!approvedAttempt || (selected != null && !matches(selected))) {
            stop();
            return;
        }
        approvedAttempt = false;
        if (!joinedTarget) {
            joinedTarget = true;
            System.out.println(JOINED_MARKER);
        }
    }

    private void onLoggingOut(ClientPlayerNetworkEvent.LoggingOut event) {
        if (!joinedTarget) return;
        markLeft();
        stop();
    }

    public static boolean allowConnection(ServerAddress address, ServerData selected) {
        Target required = Target.parse(System.getProperty(TARGET_PROPERTY, ""));
        Target fromAddress = new Target(address.getHost().toLowerCase(Locale.ROOT), address.getPort());
        Target fromSelected = selected == null ? null : Target.parse(selected.ip);
        boolean allowed = required != null && required.equals(fromAddress) && required.equals(fromSelected);
        approvedAttempt = allowed;
        return allowed;
    }

    private boolean matches(ServerData selected) {
        return target != null && target.equals(Target.parse(selected.ip));
    }

    private void markLeft() {
        if (!joinedTarget) return;
        joinedTarget = false;
        System.out.println(LEFT_MARKER);
    }

    private void stop() {
        if (stopping) return;
        stopping = true;
        Minecraft minecraft = Minecraft.getInstance();
        minecraft.execute(minecraft::stop);
    }

    private record Target(String host, int port) {
        private static Target parse(String raw) {
            if (raw == null) return null;
            String value = raw.trim();
            if (value.isEmpty()) return null;
            String host;
            String portText;
            if (value.startsWith("[")) {
                int close = value.indexOf(']');
                if (close < 2) return null;
                host = value.substring(1, close);
                if (close == value.length() - 1) {
                    portText = "25565";
                } else if (value.charAt(close + 1) == ':') {
                    portText = value.substring(close + 2);
                } else {
                    return null;
                }
            } else {
                int colon = value.lastIndexOf(':');
                if (colon < 0) {
                    host = value;
                    portText = "25565";
                } else {
                    host = value.substring(0, colon);
                    portText = value.substring(colon + 1);
                }
                if (host.contains(":")) return null;
            }
            host = host.toLowerCase(Locale.ROOT).replaceFirst("\\.$", "");
            if (host.isBlank() || host.contains("/") || host.contains(" ")) return null;
            try {
                int port = Integer.parseInt(portText);
                return port >= 1 && port <= 65535 ? new Target(host, port) : null;
            } catch (NumberFormatException error) {
                return null;
            }
        }
    }
}
