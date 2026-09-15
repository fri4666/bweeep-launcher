import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerConnection } from "../shared/types.js";

export async function readServerConnection(fallback: ServerConnection): Promise<ServerConnection> {
  try {
    return normalize(JSON.parse(await fsp.readFile(configPath(), "utf8")), fallback);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("저장된 서버 연결 설정을 읽지 못했습니다.");
  }
}

export async function writeServerConnection(value: unknown, fallback: ServerConnection): Promise<ServerConnection> {
  const connection = normalize(value, fallback);
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  const temporary = `${configPath()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(connection, null, 2), "utf8");
  await fsp.rename(temporary, configPath());
  return connection;
}

export async function resetServerConnection(fallback: ServerConnection): Promise<ServerConnection> {
  await fsp.rm(configPath(), { force: true });
  return fallback;
}

function normalize(value: unknown, fallback: ServerConnection): ServerConnection {
  const source = value as Partial<ServerConnection> | null;
  const host = typeof source?.host === "string" ? source.host.trim() : fallback.host;
  const port = typeof source?.port === "number" ? source.port : fallback.port;
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host) || host.includes("..")) {
    throw new Error("서버 주소 형식이 올바르지 않습니다.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("포트는 1부터 65535 사이여야 합니다.");
  }
  return { host, port };
}

function configPath(): string {
  return path.join(app.getPath("userData"), "server-connection.json");
}
