package com.bweeep.guard;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;

/**
 * Adds two calls to io.netty.bootstrap.Bootstrap:
 * <ul>
 *   <li>on entry to every method that takes the remote SocketAddress first,
 *   {@code Security.getProvider("BweeepGuard").get(address)}, which throws
 *   when the address is not allowed;</li>
 *   <li>before the public connect methods return, the same call with the
 *   ChannelFuture, so the guard can report the connection's outcome.</li>
 * </ul>
 * Only java.base types appear in the added code, and it has no branches, so
 * no stack map frames change.
 */
final class BootstrapTransformer implements ClassFileTransformer {
    static final String TARGET = "io/netty/bootstrap/Bootstrap";
    private static final String SOCKET_ADDRESS = "Ljava/net/SocketAddress;";
    private static final String CHANNEL_FUTURE = "Lio/netty/channel/ChannelFuture;";

    @Override
    public byte[] transform(ClassLoader loader, String className, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
        if (!TARGET.equals(className)) return null;
        try {
            ClassReader reader = new ClassReader(bytes);
            ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
            reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                @Override
                public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                    MethodVisitor visitor = super.visitMethod(access, name, descriptor, signature, exceptions);
                    boolean named = name.equals("connect") || name.equals("doResolveAndConnect") || name.equals("doConnect");
                    if (!named) return visitor;
                    boolean isStatic = (access & Opcodes.ACC_STATIC) != 0;
                    boolean checksAddress = descriptor.startsWith("(" + SOCKET_ADDRESS);
                    boolean public_ = (access & Opcodes.ACC_PUBLIC) != 0;
                    // connect(), connect(SocketAddress) and connect(SocketAddress, SocketAddress)
                    // never call one another, so each connection is reported once.
                    boolean reportsOutcome = public_ && name.equals("connect") && descriptor.endsWith(")" + CHANNEL_FUTURE)
                        && (descriptor.equals("()" + CHANNEL_FUTURE)
                            || descriptor.equals("(" + SOCKET_ADDRESS + ")" + CHANNEL_FUTURE)
                            || descriptor.equals("(" + SOCKET_ADDRESS + SOCKET_ADDRESS + ")" + CHANNEL_FUTURE));
                    if (!checksAddress && !reportsOutcome) return visitor;
                    return new GuardedMethod(visitor, checksAddress ? (isStatic ? 0 : 1) : -1, reportsOutcome);
                }
            }, 0);
            return writer.toByteArray();
        } catch (Throwable error) {
            System.out.println("BWEEP_GUARD_DISABLED " + error);
            return null;
        }
    }

    private static final class GuardedMethod extends MethodVisitor {
        private final int addressSlot;
        private final boolean reportsOutcome;

        GuardedMethod(MethodVisitor delegate, int addressSlot, boolean reportsOutcome) {
            super(Opcodes.ASM9, delegate);
            this.addressSlot = addressSlot;
            this.reportsOutcome = reportsOutcome;
        }

        @Override
        public void visitCode() {
            super.visitCode();
            if (addressSlot < 0) return;
            loadGuard();
            super.visitVarInsn(Opcodes.ALOAD, addressSlot);
            callGuard();
            super.visitInsn(Opcodes.POP);
        }

        @Override
        public void visitInsn(int opcode) {
            if (opcode == Opcodes.ARETURN && reportsOutcome) {
                // [future] -> [future, future] -> [future, future, guard] -> [future, guard, future]
                super.visitInsn(Opcodes.DUP);
                loadGuard();
                super.visitInsn(Opcodes.SWAP);
                callGuard();
                super.visitInsn(Opcodes.POP);
            }
            super.visitInsn(opcode);
        }

        private void loadGuard() {
            super.visitLdcInsn(GuardProvider.NAME);
            super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/security/Security", "getProvider", "(Ljava/lang/String;)Ljava/security/Provider;", false);
        }

        private void callGuard() {
            super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/security/Provider", "get", "(Ljava/lang/Object;)Ljava/lang/Object;", false);
        }
    }
}
