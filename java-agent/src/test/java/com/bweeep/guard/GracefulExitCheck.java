package com.bweeep.guard;

import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** An actual instrumented disconnect must allow client cleanup before JVM exit. */
public final class GracefulExitCheck {
    public static void main(String[] args) throws Exception {
        final Class<?> client = Class.forName(System.getProperty("bweeep.fixture"));
        final AtomicBoolean cleaned = new AtomicBoolean();
        Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
            @Override public void run() {
                if (!cleaned.get()) {
                    System.out.println("FAIL JVM exited before client audio cleanup");
                    Runtime.getRuntime().halt(2);
                }
            }
        }));
        int port = Integer.parseInt(System.getProperty("bweeep.targetServer").split(":")[1]);
        ServerSocket target = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"));
        NioEventLoopGroup group = new NioEventLoopGroup(1);
        Channel channel = new Bootstrap().group(group).channel(NioSocketChannel.class)
            .handler(new ChannelInitializer<SocketChannel>() {
                @Override protected void initChannel(SocketChannel socket) { }
            }).connect("127.0.0.1", port).syncUninterruptibly().channel();
        target.accept().close();
        channel.close().syncUninterruptibly();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!client.getField("stopRequested").getBoolean(null) && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        if (!client.getField("stopRequested").getBoolean(null)) {
            System.out.println("FAIL client stop was never requested");
            Runtime.getRuntime().halt(3);
        }
        if (Boolean.getBoolean("bweeep.fixtureHang")) {
            Thread.sleep(15_000);
            System.out.println("FAIL watchdog did not stop unresponsive client");
            Runtime.getRuntime().halt(4);
        }
        // Represents main/render-thread audio cleanup, which must precede JVM exit.
        Thread.sleep(300);
        group.shutdownGracefully(0, 100, TimeUnit.MILLISECONDS).syncUninterruptibly();
        target.close();
        cleaned.set(true);
        System.out.println("PASS client audio cleanup completed before JVM exit");
        System.exit(0);
    }
}
