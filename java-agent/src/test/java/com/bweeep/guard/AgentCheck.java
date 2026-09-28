package com.bweeep.guard;

import io.netty.bootstrap.Bootstrap;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Runs with the built agent and -Dbweeep.targetServer=127.0.0.1:25599 against
 * a real Netty Bootstrap, the way Minecraft connects.
 */
public final class AgentCheck {
    private static final List<String> failures = new ArrayList<String>();

    public static void main(String[] args) throws Exception {
        EventLoopGroup group = new NioEventLoopGroup(1);
        ServerSocket target = new ServerSocket(25599, 50, InetAddress.getByName("127.0.0.1"));
        ServerSocket voice = new ServerSocket(24454, 50, InetAddress.getByName("127.0.0.1"));
        try {
            Bootstrap bootstrap = new Bootstrap().group(group).channel(NioSocketChannel.class).handler(new ChannelInitializer<SocketChannel>() {
                @Override
                protected void initChannel(SocketChannel channel) {
                }
            });

            ChannelFuture joined = bootstrap.connect(InetAddress.getByName("127.0.0.1"), 25599).syncUninterruptibly();
            check("the selected server connects", joined.isSuccess());
            joined.channel().close().syncUninterruptibly();

            ChannelFuture sameHost = bootstrap.connect(new InetSocketAddress("127.0.0.1", 24454)).syncUninterruptibly();
            check("other ports on the selected server connect (voice chat)", sameHost.isSuccess());
            sameHost.channel().close().syncUninterruptibly();

            check("another server is blocked", blocked(bootstrap, new InetSocketAddress("127.0.0.2", 25565)));
            check("an unresolved other host is blocked", blocked(bootstrap, InetSocketAddress.createUnresolved("localhost.invalid", 25565)));
            check("connect() with a preset remote address is blocked too", blockedPreset(bootstrap.clone().remoteAddress(new InetSocketAddress("127.0.0.3", 25565))));
            check("web ports on other hosts are not blocked", !blocked(bootstrap, new InetSocketAddress("127.0.0.2", 443)));

            // The guard is a security provider with no algorithms; cryptography must be unaffected.
            MessageDigest.getInstance("SHA-256").digest(new byte[] { 1 });
            check("cryptography still works", true);
            check("system properties hold only strings", System.getProperties().values().stream().allMatch(value -> value instanceof String));
            Thread.sleep(300);
        } finally {
            target.close();
            voice.close();
            group.shutdownGracefully().syncUninterruptibly();
        }
        if (failures.isEmpty()) {
            System.out.println("AGENT CHECK ALL PASS");
        } else {
            System.out.println("AGENT CHECK FAILED: " + failures);
            System.exit(1);
        }
    }

    private static boolean blocked(Bootstrap bootstrap, InetSocketAddress address) {
        try {
            ChannelFuture future = bootstrap.connect(address).awaitUninterruptibly();
            if (future.channel() != null) future.channel().close();
            return false;
        } catch (IllegalStateException error) {
            return error.getMessage().contains("선택한 서버");
        }
    }

    private static boolean blockedPreset(Bootstrap bootstrap) {
        try {
            bootstrap.connect().awaitUninterruptibly();
            return false;
        } catch (IllegalStateException error) {
            return error.getMessage().contains("선택한 서버");
        }
    }

    private static void check(String name, boolean ok) {
        System.out.println((ok ? "PASS " : "FAIL ") + name);
        if (!ok) failures.add(name);
    }
}
