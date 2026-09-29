package com.bweeep.guard;

import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.Security;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs with the built agent against a real Netty Bootstrap. The agent's own
 * provider is swapped for one whose leave watch only counts exits.
 */
public final class LeaveCheck {
    private static final long GRACE_MS = 300;
    private static final String HOST = "127.0.0.1";
    private static final List<String> failures = new ArrayList<String>();
    private static final AtomicInteger exits = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        EventLoopGroup group = new NioEventLoopGroup(1);
        ServerSocket target = new ServerSocket(25598, 50, InetAddress.getByName(HOST));
        ServerSocket voice = new ServerSocket(24455, 50, InetAddress.getByName(HOST));
        try {
            Bootstrap bootstrap = new Bootstrap().group(group).channel(NioSocketChannel.class).handler(new ChannelInitializer<SocketChannel>() {
                @Override
                protected void initChannel(SocketChannel channel) {
                }
            });

            watch("127.0.0.1:25598");
            Channel joined = connect(bootstrap, 25598);
            Socket accepted = target.accept();
            check("the game stays while connected", exitsAfterGrace() == 0);
            joined.close().syncUninterruptibly();
            check("leaving the server ends the game", exitsAfterGrace() == 1);
            accepted.close();

            watch("127.0.0.1:25598");
            joined = connect(bootstrap, 25598);
            target.accept().close();
            joined.closeFuture().syncUninterruptibly();
            check("a kick or a server shutdown ends the game", exitsAfterGrace() == 1);

            watch("127.0.0.1:25596");
            check("the connection fails", !bootstrap.connect(HOST, 25596).awaitUninterruptibly().isSuccess());
            check("failing to reach the server ends the game", exitsAfterGrace() == 1);

            watch("127.0.0.1:25598");
            Channel voiceChat = connect(bootstrap, 24455);
            voice.accept().close();
            voiceChat.close().syncUninterruptibly();
            bootstrap.connect(new InetSocketAddress("127.0.0.2", 443)).awaitUninterruptibly();
            check("other connections ending leave the game alone", exitsAfterGrace() == 0);

            watch("127.0.0.1:25598");
            joined = connect(bootstrap, 25598);
            accepted = target.accept();
            joined.close().syncUninterruptibly();
            accepted.close();
            Channel again = connect(bootstrap, 25598);
            accepted = target.accept();
            check("reconnecting to the server right away keeps the game", exitsAfterGrace() == 0);
            again.close().syncUninterruptibly();
            accepted.close();
            check("leaving after the reconnect ends the game once", exitsAfterGrace() == 1);
        } finally {
            target.close();
            voice.close();
            group.shutdownGracefully().syncUninterruptibly();
        }
        if (failures.isEmpty()) {
            System.out.println("LEAVE CHECK ALL PASS");
        } else {
            System.out.println("LEAVE CHECK FAILED: " + failures);
            System.exit(1);
        }
    }

    /** A fresh provider for the selected server, whose exits are counted from zero. */
    private static void watch(String server) {
        Security.removeProvider(GuardProvider.NAME);
        exits.set(0);
        Security.addProvider(new GuardProvider(TargetPolicy.parse(server), new LeaveWatch(GRACE_MS, new Runnable() {
            @Override
            public void run() {
                exits.incrementAndGet();
            }
        })));
    }

    private static Channel connect(Bootstrap bootstrap, int port) {
        return bootstrap.connect(HOST, port).syncUninterruptibly().channel();
    }

    private static int exitsAfterGrace() throws InterruptedException {
        Thread.sleep(GRACE_MS + 700);
        return exits.get();
    }

    private static void check(String name, boolean ok) {
        System.out.println((ok ? "PASS " : "FAIL ") + name);
        if (!ok) failures.add(name);
    }
}
