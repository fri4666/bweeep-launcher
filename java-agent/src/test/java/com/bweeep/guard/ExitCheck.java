package com.bweeep.guard;

import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Runs with the built agent, -Dbweeep.targetServer=127.0.0.1:25597 and
 * -Dbweeep.exitOnLeave=true: leaving the server must end this JVM with code 0,
 * and nothing before that may end it.
 */
public final class ExitCheck {
    public static void main(String[] args) throws Exception {
        final AtomicLong leftAt = new AtomicLong();
        Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
            @Override
            public void run() {
                long left = leftAt.get();
                if (left == 0) {
                    System.out.println("EXIT CHECK FAILED: ended while still connected");
                    Runtime.getRuntime().halt(2);
                }
                System.out.println("EXIT CHECK PASS: ended " + (System.currentTimeMillis() - left) + " ms after leaving");
            }
        }));
        ServerSocket target = new ServerSocket(25597, 50, InetAddress.getByName("127.0.0.1"));
        Bootstrap bootstrap = new Bootstrap().group(new NioEventLoopGroup(1)).channel(NioSocketChannel.class).handler(new ChannelInitializer<SocketChannel>() {
            @Override
            protected void initChannel(SocketChannel channel) {
            }
        });
        Channel joined = bootstrap.connect("127.0.0.1", 25597).syncUninterruptibly().channel();
        target.accept();
        Thread.sleep(2_000);
        System.out.println("PASS the game stays while connected");
        leftAt.set(System.currentTimeMillis());
        joined.close().syncUninterruptibly();
        Thread.sleep(15_000);
        System.out.println("EXIT CHECK FAILED: still running 15 s after leaving");
        Runtime.getRuntime().halt(1);
    }
}
