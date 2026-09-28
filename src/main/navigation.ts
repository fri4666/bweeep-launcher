// The launcher window only ever shows its own renderer (the bundled file or
// the dev server). The preload bridge is exposed to whatever page the window
// shows, so a link or script must never move the window to another page.

/** True when a navigation stays on the page that is already loaded (a reload). */
export function isSameDocument(current: string, target: string): boolean {
  try {
    const from = new URL(current);
    const to = new URL(target);
    return (from.protocol === "file:" || from.protocol === "http:") && from.protocol === to.protocol && from.host === to.host && from.pathname === to.pathname;
  } catch {
    return false;
  }
}

/** Game servers from the catalog are the only hosts the status check may connect to. */
export function isCatalogServer(value: unknown, servers: Iterable<{ host: string; port: number }>): value is { host: string; port: number } {
  if (!value || typeof value !== "object") return false;
  const { host, port } = value as { host?: unknown; port?: unknown };
  if (typeof host !== "string" || typeof port !== "number") return false;
  for (const server of servers) {
    if (server.host === host && server.port === port) return true;
  }
  return false;
}
