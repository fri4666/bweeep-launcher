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
        latencyMs: Math.round(performance.now() - startedAt),
        message
      });
    };

    socket.setTimeout(3500);
    socket.once("connect", () => finish(true, "서버 연결 가능"));
    socket.once("timeout", () => finish(false, "서버 응답 없음"));
    socket.once("error", () => finish(false, "서버에 연결할 수 없음"));
  });
}
