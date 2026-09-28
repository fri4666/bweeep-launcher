package com.bweeep.guard;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Hashtable;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.InitialDirContext;

/**
 * Which connections a guarded client may open:
 * <ul>
 *   <li>the selected server, by name or by any address it or its Minecraft
 *   SRV record resolves to, on any port (voice chat and similar mods talk to
 *   the same machine on other ports);</li>
 *   <li>any host on ports 80 and 443, which are web requests, never Minecraft
 *   servers the player could join.</li>
 * </ul>
 * Only connections to the game port (or the SRV record's port) count as the
 * selected server for reporting.
 */
final class TargetPolicy {
    enum Decision { TARGET, ALLOWED, BLOCKED }

    private static final long RESOLVE_INTERVAL_MS = 60_000L;

    private final String host;
    private final int port;
    private volatile Set<String> names = Collections.emptySet();
    /** Game ports named by the SRV record. */
    private volatile Set<Integer> ports = Collections.emptySet();
    private volatile Set<InetAddress> addresses = Collections.emptySet();
    private volatile long resolvedAt;

    private TargetPolicy(String host, int port) {
        this.host = host.toLowerCase(Locale.ROOT);
        this.port = port;
    }

    /** Parses "host:port" or "[ipv6]:port". */
    static TargetPolicy parse(String value) {
        int colon = value.lastIndexOf(':');
        if (colon <= 0 || colon == value.length() - 1) throw new IllegalArgumentException(value);
        String host = value.substring(0, colon);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        int port;
        try {
            port = Integer.parseInt(value.substring(colon + 1));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(value);
        }
        if (host.isEmpty() || port < 1 || port > 65535) throw new IllegalArgumentException(value);
        return new TargetPolicy(host, port);
    }

    Decision decide(InetSocketAddress address) {
        String name = address.getHostString().toLowerCase(Locale.ROOT);
        refresh();
        if (names.contains(name)) return targetOrAllowed(address);
        InetAddress resolved = address.getAddress();
        if (resolved == null) {
            try {
                resolved = InetAddress.getByName(name);
            } catch (Exception error) {
                resolved = null;
            }
        }
        if (resolved != null && addresses.contains(resolved)) return targetOrAllowed(address);
        if (address.getPort() == 80 || address.getPort() == 443) return Decision.ALLOWED;
        return Decision.BLOCKED;
    }

    private Decision targetOrAllowed(InetSocketAddress address) {
        return address.getPort() == port || ports.contains(address.getPort()) ? Decision.TARGET : Decision.ALLOWED;
    }

    /** Re-resolves the selected server now and then, since its address may change while the game runs. */
    private synchronized void refresh() {
        long now = System.currentTimeMillis();
        if (now - resolvedAt < RESOLVE_INTERVAL_MS && !addresses.isEmpty()) return;
        Set<String> nextNames = new HashSet<String>();
        Set<Integer> nextPorts = new HashSet<Integer>();
        nextNames.add(host);
        for (String[] srv : srvTargets(host)) {
            nextNames.add(srv[0]);
            try {
                nextPorts.add(Integer.valueOf(srv[1]));
            } catch (NumberFormatException ignored) {
                // Malformed record; the name still counts.
            }
        }
        Set<InetAddress> nextAddresses = new HashSet<InetAddress>();
        for (String name : nextNames) {
            try {
                Collections.addAll(nextAddresses, InetAddress.getAllByName(name));
            } catch (Exception ignored) {
                // An unresolvable name only matches by name.
            }
        }
        names = nextNames;
        ports = nextPorts;
        addresses = nextAddresses;
        resolvedAt = now;
    }

    /** Host and port pairs from the server's _minecraft._tcp SRV record, which the client follows. */
    private static List<String[]> srvTargets(String host) {
        List<String[]> targets = new ArrayList<String[]>();
        // An address has no SRV record; asking would only wait for the DNS timeout.
        if (host.matches("[0-9.]+") || host.indexOf(':') >= 0 || host.indexOf('.') < 0) return targets;
        try {
            Hashtable<String, String> environment = new Hashtable<String, String>();
            environment.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
            environment.put("com.sun.jndi.dns.timeout.initial", "1000");
            environment.put("com.sun.jndi.dns.timeout.retries", "1");
            InitialDirContext context = new InitialDirContext(environment);
            try {
                Attributes attributes = context.getAttributes("_minecraft._tcp." + host, new String[] { "SRV" });
                Attribute srv = attributes.get("srv");
                for (int index = 0; srv != null && index < srv.size(); index++) {
                    String[] parts = String.valueOf(srv.get(index)).trim().split("\\s+");
                    if (parts.length == 4) targets.add(new String[] { parts[3].replaceAll("\\.$", "").toLowerCase(Locale.ROOT), parts[2] });
                }
            } finally {
                context.close();
            }
        } catch (Throwable ignored) {
            // No SRV record, or no DNS access.
        }
        return targets;
    }
}
