import net from "node:net";
import type { ServerStatus } from "../shared/types.js";

export async function checkServer(server: { host: string; port: number }): Promise<ServerStatus> {
  const { host, port } = server;
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (online: boolean, message: string) => {
      socket.destroy();
      resolve({
        online,
        host,
        port,
        ...(online ? { latencyMs: Math.round(performance.now() - startedAt) } : {}),
        message: online ? message : "연결 끊김"
      });
    };

    socket.setTimeout(3500);
    socket.once("connect", () => finish(true, "서버 연결 가능"));
    socket.once("timeout", () => finish(false, "연결 끊김"));
    socket.once("error", () => finish(false, "연결 끊김"));
  });
}
