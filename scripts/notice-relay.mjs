#!/usr/bin/env node
// Turns the notices an admin posts in the launcher into in-game banners: every
// ~15 s it reads the notices that are currently shown (public.launcher_notices,
// ended_at is null) and, for a notice it has not announced yet, sends it with
// scripts/bweeep-notify.mjs to servers whose backend is RUNNING right now.
//   - the notice everyone sees (target_user_id is null) goes to every player;
//   - a personal notice goes only to its member, by game name, on the running
//     servers where RCON `list` shows that player online (a player who is not
//     on a server is simply skipped there; the launcher still shows the notice).
// Servers that are asleep or stopped are skipped; nothing is ever woken. The
// banner reaches a server once per notice (state file survives restarts), and a
// notice older than 10 minutes is never replayed.
//
//   node scripts/notice-relay.mjs                 run forever (systemd unit)
//   node scripts/notice-relay.mjs --once          one poll, then exit
//   node scripts/notice-relay.mjs --install       write the service key file and
//                                                 copy the scripts next to the gate
//
// Secrets: the service key lives only in ~/.config/bweeep/notice-relay.env
// (mode 600) and is never printed or logged.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNoticeCommand, PLAYER_NAME } from "./bweeep-notify.mjs";
import { readConfig, rconCommand } from "./server-gate.mjs";

export const PROJECT_REF = "tmwvrglzjfzauuygofpp";
export const POLL_MS = 15_000;
export const MAX_AGE_MS = 10 * 60_000;
export const BANNER_SECONDS = 8;
export const BANNER_LEVEL = "info";
export const MAX_BACKOFF_MS = 5 * 60_000;
const KEEP_NOTICES = 20;
const DEFAULT_GATE_DIR = "/home/dev/servers/bweeep-gate";
const DEFAULT_STATE = path.join(os.homedir(), ".local", "state", "bweeep-notice-relay.json");
const ENV_FILE = path.join(os.homedir(), ".config", "bweeep", "notice-relay.env");

/** Every RCON-enabled server named by a gate config in the folder (*.json only). */
export function loadServers(gateDir = DEFAULT_GATE_DIR, log = () => {}) {
  const servers = [];
  let names = [];
  try {
    names = fs.readdirSync(gateDir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    log(`게이트 폴더를 읽지 못했습니다: ${error.code ?? error.message}`);
    return servers;
  }
  for (const name of names) {
    let config;
    try {
      config = readConfig(path.join(gateDir, name));
    } catch (error) {
      log(`게이트 설정을 건너뜁니다 ${name}: ${error.message}`);
      continue;
    }
    for (const entry of config.servers) {
      if (!entry.rcon) continue;
      servers.push({ unit: entry.unit, name: entry.name ?? entry.unit, port: entry.rcon.port, password: entry.rcon.password });
    }
  }
  return servers;
}

/** True when something accepts connections on the backend's RCON port (the server is up). */
export function isListening(port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value === "object" && value.notices && typeof value.notices === "object") return value;
  } catch {
    // missing or damaged: start empty, which only means a recent notice may be shown once more
  }
  return { notices: {} };
}

function writeState(file, state) {
  const ids = Object.keys(state.notices);
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_NOTICES))) delete state.notices[id];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  fs.writeFileSync(part, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(part, file);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restHeaders(key) {
  return { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" };
}

/** The in-game names of members (saved profile first, then the account they played with). */
export async function fetchGameNames({ url, key, userIds, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const ids = [...new Set(userIds)].filter((id) => UUID.test(id));
  const names = new Map();
  if (ids.length === 0) return names;
  const list = encodeURIComponent(`(${ids.join(",")})`);
  for (const table of ["launcher_minecraft_accounts", "launcher_profiles"]) { // later wins: the saved profile
    const response = await fetchImpl(`${url}/rest/v1/${table}?user_id=in.${list}&select=user_id,game_name`, {
      headers: restHeaders(key),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const row of await response.json()) if (typeof row.game_name === "string") names.set(row.user_id, row.game_name);
  }
  return names;
}

/**
 * Every notice that is shown right now: the one everyone sees (or null) and the
 * personal ones, each with the in-game name of its member (null when unknown).
 * Throws on a failed read. Before the personal-notice migration the table has
 * no target column; that answer is read as "only the notice everyone sees".
 */
export async function fetchActiveNotices({ url, key, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const request = (query) => fetchImpl(`${url}/rest/v1/launcher_notices?${query}`, { headers: restHeaders(key), signal: AbortSignal.timeout(timeoutMs) });
  let response = await request("ended_at=is.null&select=id,body,created_at,target_user_id&order=created_at.desc&limit=200");
  if (response.status === 400 && /target_user_id/.test(await response.clone().text().catch(() => ""))) {
    response = await request("ended_at=is.null&select=id,body,created_at&order=created_at.desc&limit=1");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) return { everyone: null, personal: [] };
  const everyone = rows.find((row) => !row.target_user_id) ?? null;
  const personalRows = rows.filter((row) => row.target_user_id);
  const names = personalRows.length > 0
    ? await fetchGameNames({ url, key, userIds: personalRows.map((row) => row.target_user_id), fetchImpl, timeoutMs })
    : new Map();
  return {
    everyone,
    personal: personalRows.map((row) => ({
      id: row.id,
      body: row.body,
      created_at: row.created_at,
      target: { userId: row.target_user_id, gameName: names.get(row.target_user_id) ?? null }
    }))
  };
}

/** The notice everyone sees, or null; throws on a failed read. */
export async function fetchCurrentNotice(options) {
  return (await fetchActiveNotices(options)).everyone;
}

/** The players RCON `list` reports, or null when the server did not answer. */
export function parseOnlinePlayers(reply) {
  if (typeof reply !== "string") return null;
  const match = /players?\s+online:\s*(.*)$/is.exec(reply.trim());
  if (!match) return reply.trim() === "" ? [] : null;
  return match[1].split(",").map((name) => name.trim()).filter(Boolean);
}

/**
 * One relay. `tick()` polls once and delivers; it never throws. Delivery is per
 * (notice, server): a server that was asleep gets the banner later if it wakes
 * within the notice's 10 minutes, and "no player was found" counts as not
 * delivered so a player who joins soon after still sees it. A personal notice
 * is sent only on a server whose `list` shows its member online.
 *
 * `readNotices` answers { everyone, personal }; `readNotice` (older shape, only
 * the notice everyone sees) still works for callers that have just that.
 */
export function createRelay({
  readNotices,
  readNotice,
  gateDir = DEFAULT_GATE_DIR,
  stateFile = DEFAULT_STATE,
  now = () => Date.now(),
  log = (line) => console.log(line),
  rcon = rconCommand,
  listening = isListening,
  maxAgeMs = MAX_AGE_MS
}) {
  let failures = 0;
  const read = readNotices ?? (async () => ({ everyone: await readNotice(), personal: [] }));

  /** Marks a notice that cannot be sent right now, once; false when it is fresh and sendable. */
  function skipped(state, record, notice, what) {
    const age = now() - Date.parse(notice.created_at);
    if (!Number.isFinite(age) || age > maxAgeMs) {
      if (!record.stale) {
        record.stale = true;
        writeState(stateFile, state);
        log(`오래된 ${what}라 보내지 않습니다 (${Number.isFinite(age) ? Math.round(age / 60_000) : "?"}분 전)`);
      }
      return true;
    }
    return false;
  }

  async function sendEveryone(state, notice) {
    const record = (state.notices[notice.id] ??= { units: [], seenAt: now() });
    if (skipped(state, record, notice, "공지")) return [];
    let command;
    try {
      command = buildNoticeCommand({ level: BANNER_LEVEL, seconds: BANNER_SECONDS, text: notice.body }).command;
    } catch (error) {
      if (!record.invalid) {
        record.invalid = true;
        writeState(stateFile, state);
        log(`보낼 수 없는 공지입니다: ${error.message}`);
      }
      return [];
    }
    const delivered = [];
    let changed = false;
    for (const server of loadServers(gateDir, log)) {
      if (record.units.includes(server.unit)) continue;
      try {
        if (!(await listening(server.port))) continue; // asleep or stopped: skip quietly, never woken
        const reply = await rcon(server.port, server.password, command);
        if (reply === null) {
          log(`${server.unit}: 실패 (RCON 응답 없음)`);
        } else if (/no player was found|no entity was found/i.test(reply)) {
          log(`${server.unit}: 접속자가 없어 보류`);
        } else {
          record.units.push(server.unit);
          delivered.push(server.unit);
          changed = true;
          log(`${server.unit}: 보냄`);
        }
      } catch (error) {
        log(`${server.unit}: 실패 (${error.message})`);
      }
    }
    if (changed) writeState(stateFile, state);
    return delivered;
  }

  async function sendPersonal(state, notice) {
    const record = (state.notices[notice.id] ??= { units: [], seenAt: now(), personal: true });
    if (skipped(state, record, notice, "개인 공지")) return [];
    const tag = `개인 공지 ${String(notice.id).slice(0, 8)}`; // the text itself is never logged
    const name = notice.target?.gameName;
    let command;
    try {
      if (!name) throw new Error("받는 사람의 게임 이름을 모릅니다");
      // `@a` is a valid banner target but would turn a personal notice into a broadcast.
      if (!PLAYER_NAME.test(name)) throw new Error("받는 사람의 게임 이름이 올바르지 않습니다");
      command = buildNoticeCommand({ level: BANNER_LEVEL, seconds: BANNER_SECONDS, text: notice.body, target: name }).command;
    } catch (error) {
      if (!record.invalid) {
        record.invalid = true;
        writeState(stateFile, state);
        log(`${tag}: 보낼 수 없습니다 (${error.message})`);
      }
      return [];
    }
    const delivered = [];
    let changed = false;
    for (const server of loadServers(gateDir, log)) {
      if (record.units.includes(server.unit)) continue;
      try {
        if (!(await listening(server.port))) continue;
        const online = parseOnlinePlayers(await rcon(server.port, server.password, "list"));
        if (online === null) {
          log(`${server.unit}: 실패 (접속자 목록을 읽지 못함)`);
          continue;
        }
        if (!online.some((player) => player.toLowerCase() === name.toLowerCase())) continue; // not on this server: skip quietly
        const reply = await rcon(server.port, server.password, command);
        if (reply === null) {
          log(`${server.unit}: 실패 (RCON 응답 없음)`);
        } else if (/no player was found|no entity was found/i.test(reply)) {
          log(`${server.unit}: ${tag} 받는 사람이 방금 나가 보류`);
        } else {
          record.units.push(server.unit);
          delivered.push(server.unit);
          changed = true;
          log(`${server.unit}: ${tag} → ${name} 보냄`);
        }
      } catch (error) {
        log(`${server.unit}: 실패 (${error.message})`);
      }
    }
    if (changed) writeState(stateFile, state);
    return delivered;
  }

  async function tick() {
    let notices;
    try {
      notices = await read();
    } catch (error) {
      failures += 1;
      log(`공지를 읽지 못했습니다(${failures}번째): ${error.message}`);
      return { ok: false, delivered: [], personalDelivered: [] };
    }
    if (failures > 0) log("공지 읽기가 다시 됩니다.");
    failures = 0;
    const state = readState(stateFile);
    const delivered = notices.everyone ? await sendEveryone(state, notices.everyone) : [];
    const personalDelivered = [];
    for (const notice of notices.personal ?? []) {
      for (const unit of await sendPersonal(state, notice)) personalDelivered.push({ id: notice.id, unit });
    }
    return { ok: true, delivered, personalDelivered };
  }

  return { tick, get failures() { return failures; } };
}

export function backoffDelay(failures, pollMs = POLL_MS) {
  return failures <= 0 ? pollMs : Math.min(MAX_BACKOFF_MS, pollMs * 2 ** Math.min(failures, 10));
}

function loadEnvFile(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    // reported by the caller
  }
  return env;
}

async function install() {
  const tokenFile = path.join(os.homedir(), ".supabase", "access-token");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`서비스 키를 읽지 못했습니다 (HTTP ${response.status})`);
  const key = (await response.json()).find((item) => item.name === "service_role")?.api_key;
  if (!key) throw new Error("service_role 키를 찾지 못했습니다.");
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENV_FILE, `SUPABASE_URL=https://${PROJECT_REF}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${key}\n`, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  console.log(`키 파일을 썼습니다: ${ENV_FILE} (내용은 출력하지 않습니다)`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["notice-relay.mjs", "bweeep-notify.mjs"]) {
    fs.copyFileSync(path.join(here, name), path.join(DEFAULT_GATE_DIR, name));
  }
  if (!fs.existsSync(path.join(DEFAULT_GATE_DIR, "server-gate.mjs"))) fs.copyFileSync(path.join(here, "server-gate.mjs"), path.join(DEFAULT_GATE_DIR, "server-gate.mjs"));
  console.log(`스크립트를 ${DEFAULT_GATE_DIR} 에 복사했습니다.`);
}

function parseArgs(argv) {
  const options = { once: false, install: false, gateDir: DEFAULT_GATE_DIR, stateFile: DEFAULT_STATE, pollMs: POLL_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--install") options.install = true;
    else if (arg === "--gate-dir" || arg === "--state" || arg === "--interval") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} 값이 필요합니다.`);
      const value = argv[(i += 1)];
      if (arg === "--gate-dir") options.gateDir = value;
      else if (arg === "--state") options.stateFile = value;
      else options.pollMs = Math.max(1_000, Number(value) * 1_000 || POLL_MS);
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.install) {
    await install();
    return 0;
  }
  const env = { ...loadEnvFile(ENV_FILE), ...process.env };
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다. 먼저 --install 을 실행하세요. (${ENV_FILE})`);
    return 1;
  }
  const relay = createRelay({
    readNotices: () => fetchActiveNotices({ url, key }),
    gateDir: options.gateDir,
    stateFile: options.stateFile,
    log: (line) => console.log(line)
  });
  if (options.once) {
    const result = await relay.tick();
    console.log(`한 번 확인했습니다: ${result.ok ? "정상" : "읽기 실패"}, 보낸 서버 ${result.delivered.length}개, 개인 공지 ${result.personalDelivered.length}건`);
    return result.ok ? 0 : 1;
  }
  console.log(`공지 중계를 시작합니다 (${options.pollMs / 1000}초마다 확인)`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
  let polls = 0;
  for (;;) {
    await relay.tick();
    polls += 1;
    if (polls === 1) console.log("첫 확인을 마쳤습니다.");
    await new Promise((resolve) => setTimeout(resolve, backoffDelay(relay.failures, options.pollMs)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
