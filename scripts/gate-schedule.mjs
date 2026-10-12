#!/usr/bin/env node
// Opening hours for the server gates: check, write into gate.json, load into a
// running gate, open a closed server by hand, and put new gate code in place.
// Nothing here changes anything unless `--write` is given, and this tool never
// touches a Minecraft server itself. (A gate that has hours does stop its
// server, warned and gracefully, when they end; `show` says beforehand what a
// gate will do the moment it reads the hours.) See scripts/SERVER-SCHEDULE.md.
//
//   node scripts/gate-schedule.mjs show   --config <gate.json> [--at 2026-10-30T12:00+09:00]
//   node scripts/gate-schedule.mjs apply  --config <gate.json> [--write]   standard hours for known units
//   node scripts/gate-schedule.mjs clear  --config <gate.json> [--write]   remove the hours (always open again)
//   node scripts/gate-schedule.mjs reload --config <gate.json> [--write]   gate re-reads the hours, connections untouched (SIGHUP)
//   node scripts/gate-schedule.mjs open   --config <gate.json> --hours 3 [--write]  open a closed server by hand
//   node scripts/gate-schedule.mjs close-by-hand --config <gate.json> [--write]     end that
//   node scripts/gate-schedule.mjs install --config <gate.json> [--write]  new gate code + restart, only while nobody is on
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, changesBetween, formatOpenTime, gateCodeHash, isOpenAt, nextCloseAt, nextOpenAt, parseSchedule, probeBackend, readConfig } from "./server-gate.mjs";

// ★ The hours live here and nowhere else. "오후" was never given an exact hour, so noon is used.
/** The hour both servers hand over on: Friday and Sunday. */
export const OPEN_HOUR = "12:00";
/** First day the hours apply (Korean date). Before it every server stays always open. Two weeks after the test weekend of 2026-10-09..11. */
export const STARTS_ON = "2026-10-23";
/** Cobblemon: Friday afternoon to Sunday afternoon. Sunlit Valley: Sunday afternoon to Friday afternoon. No overlap, no gap. */
export const STANDARD_HOURS = {
  "bweeep-cobblemon-fabric": [{ from: `fri ${OPEN_HOUR}`, to: `sun ${OPEN_HOUR}` }],
  "bweeep-society-server": [{ from: `sun ${OPEN_HOUR}`, to: `fri ${OPEN_HOUR}` }]
};

/** The schedule block for a known unit, or undefined. */
export function standardSchedule(unit) {
  const open = STANDARD_HOURS[unit];
  return open ? { startsOn: STARTS_ON, open: open.map((window) => ({ ...window })) } : undefined;
}

/** gate.json with the standard hours on every known unit (others untouched); `changed` lists the units. */
export function withStandardHours(config) {
  const changed = [];
  const servers = config.servers.map((server) => {
    const schedule = standardSchedule(server.unit);
    if (!schedule) return server;
    parseSchedule(schedule, `${server.unit}.schedule`);
    if (JSON.stringify(server.schedule) !== JSON.stringify(schedule)) changed.push(server.unit);
    return { ...server, schedule };
  });
  return { config: { ...config, servers }, changed };
}

/** gate.json without any schedule block. */
export function withoutHours(config) {
  const changed = config.servers.filter((server) => server.schedule !== undefined).map((server) => server.unit);
  return { config: { ...config, servers: config.servers.map(({ schedule: _schedule, ...rest }) => rest) }, changed };
}

/** One line per server: what the hours say at `ms`. */
export function describeHours(config, ms, openedByHand = () => false) {
  return config.servers.map((server) => {
    if (!server.schedule) return `${server.unit}: 시간표 없음 (항상 열림)`;
    const hours = parseSchedule(server.schedule, `${server.unit}.schedule`);
    const hand = openedByHand(server.unit) ? " · 손으로 열어 둔 상태" : "";
    if (hours.startsOnMs !== null && ms < hours.startsOnMs) return `${server.unit}: ${server.schedule.startsOn} 전이라 항상 열림${hand}`;
    if (isOpenAt(hours, ms)) return `${server.unit}: 지금 열림 · ${formatOpenTime(nextCloseAt(hours, ms))}에 닫힘${hand}`;
    return `${server.unit}: 지금 닫힘 · ${formatOpenTime(nextOpenAt(hours, ms))}에 열림${hand}`;
  });
}

/**
 * What each gate will do the moment it reads these hours at `ms`, from the gate's own memory of handled
 * boundaries and whether the server is up. One line per server with hours.
 */
export async function forecast(config, ms, probe = (port) => probeBackend(port, 1_500)) {
  const lines = [];
  for (const server of config.servers) {
    if (!server.schedule) continue;
    const hours = parseSchedule(server.schedule, `${server.unit}.schedule`);
    let handled = { stop: 0, start: 0 };
    try { handled = JSON.parse(fs.readFileSync(path.join(config.stateDir, `${server.unit}.hours.json`), "utf8")); } catch { /* no memory yet */ }
    let until = 0;
    try {
      const text = fs.readFileSync(path.join(config.stateDir, `${server.unit}.open-until`), "utf8").trim();
      until = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    } catch { /* no hand-opened period */ }
    const last = changesBetween(hours, Number.isFinite(until) ? until : 0, ms - 8 * 86_400_000, ms).at(-1);
    const running = (await probe(server.backend)).status !== null;
    let todo = "할 일 없음";
    if (last?.type === "close" && !(handled.stop >= last.at)) todo = running ? `서버가 켜져 있어 경고 후 끕니다(${formatOpenTime(last.at)}에 닫혔어야 함)` : "서버가 꺼져 있어 아무것도 하지 않음";
    if (last?.type === "open" && !(handled.start >= last.at) && ms - last.at <= DEFAULTS.startFreshMs) todo = running ? "이미 켜져 있음" : `${Math.max(0, Math.ceil((last.at + DEFAULTS.openStartDelayMs - ms) / 1000))}초 안에 서버를 켭니다`;
    lines.push(`${server.unit}: ${todo}`);
  }
  return lines;
}

// ---- command line

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 60_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}`.trim() }));
});

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, write: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--even-if-players") options.evenIfPlayers = true;
    else if (arg === "--config") options.config = rest[++index];
    else if (arg === "--at") options.at = rest[++index];
    else if (arg === "--hours") options.hours = Number(rest[++index]);
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!options.config) throw new Error("--config <gate.json> 이 필요합니다.");
  return options;
}

function writeJson(file, value) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return backup;
}

function handOpenFile(config, unit) {
  return path.join(config.stateDir, `${unit}.open-until`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const file = path.resolve(options.config);
  const config = readConfig(file);
  const say = (line = "") => console.log(line);
  const dry = (what) => say(options.write ? what : `(미리보기) ${what}  ← 실제로 하려면 --write`);
  const at = options.at ? Date.parse(options.at) : Date.now();
  if (!Number.isFinite(at)) throw new Error("--at 은 2026-10-30T12:00+09:00 같은 시각이어야 합니다.");
  const unitName = path.basename(file, ".json");

  switch (options.command) {
    case "show": {
      say(`기준 시각: ${new Date(at).toISOString()} (한국 시간 ${formatOpenTime(at)})`);
      for (const line of describeHours(config, at, (unit) => {
        try { return Date.parse(fs.readFileSync(handOpenFile(config, unit), "utf8").trim()) > Date.now(); } catch { return false; }
      })) say(line);
      say("게이트가 이 시간표를 읽는 순간 하게 될 일:");
      for (const line of await forecast(config, at)) say(`  ${line}`);
      break;
    }
    case "apply":
    case "clear": {
      const { config: next, changed } = options.command === "apply" ? withStandardHours(config) : withoutHours(config);
      if (changed.length === 0) { say("바꿀 것이 없습니다."); break; }
      for (const unit of changed) say(`${unit}: ${options.command === "apply" ? JSON.stringify(next.servers.find((server) => server.unit === unit).schedule) : "시간표 제거"}`);
      if (options.write) say(`gate.json 을 고쳤습니다. 백업: ${writeJson(file, next)}\n실행 중인 게이트에 반영하려면: reload (새 게이트 코드가 먼저 깔려 있어야 합니다. install 참고)`);
      else dry("gate.json 을 고칩니다.");
      break;
    }
    case "reload": {
      say("게이트가 지금 시간표를 읽으면:");
      for (const line of await forecast(config, Date.now())) say(`  ${line}`);
      dry(`systemctl --user kill --kill-whom=main -s HUP bweeep-gate@${unitName}`);
      if (options.write) {
        const result = await run("systemctl", ["--user", "kill", "--kill-whom=main", "-s", "HUP", `bweeep-gate@${unitName}`]);
        say(result.ok ? "시간표를 다시 읽게 했습니다. 접속은 끊기지 않습니다." : `실패: ${result.out}`);
      }
      break;
    }
    case "open": {
      if (!(options.hours > 0 && options.hours <= 48)) throw new Error("--hours 는 0 보다 크고 48 이하여야 합니다.");
      for (const server of config.servers) {
        const until = new Date(Date.now() + options.hours * 3_600_000).toISOString();
        dry(`${server.unit}: ${until} 까지 시간과 상관없이 켜질 수 있게 합니다.`);
        if (options.write) {
          fs.mkdirSync(config.stateDir, { recursive: true });
          fs.writeFileSync(handOpenFile(config, server.unit), `${until}\n`);
        }
      }
      break;
    }
    case "close-by-hand": {
      for (const server of config.servers) {
        dry(`${server.unit}: 손으로 연 상태를 끝냅니다. (이미 켜진 서버는 그대로 둡니다)`);
        if (options.write) fs.rmSync(handOpenFile(config, server.unit), { force: true });
      }
      break;
    }
    case "install": {
      // New gate code takes over only by restarting the gate, which cuts every connection that goes through it.
      const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "server-gate.mjs");
      const target = path.join(path.dirname(file), "server-gate.mjs");
      const wanted = gateCodeHash(source);
      const copied = fs.existsSync(target) && gateCodeHash(target) === wanted;
      // Each gate process records the hash of the code it started with.
      const running = (() => { try { return fs.readFileSync(path.join(config.stateDir, `${unitName}.gate-code`), "utf8").trim(); } catch { return ""; } })();
      const restartNeeded = running !== wanted;
      say(`${copied ? "게이트 코드 파일: 이미 최신" : `게이트 코드 파일: ${target} 를 교체`} · 실행 중인 게이트: ${restartNeeded ? "옛 코드라 다시 시작 필요" : "이미 최신"}`);
      if (copied && !restartNeeded) break;
      const busy = [];
      if (restartNeeded) {
        for (const server of config.servers) {
          const { status } = await probeBackend(server.backend, 2_000);
          const online = status?.players?.online ?? 0;
          say(`${server.unit}: 지금 접속 ${online}명${status ? "" : " (서버가 꺼져 있음)"}`);
          if (online > 0) busy.push(server.unit);
        }
        if (busy.length > 0 && !options.evenIfPlayers) {
          say(`접속자가 있어 멈춥니다(${busy.join(", ")}). 게이트를 다시 시작하면 그 사람들의 접속이 끊깁니다. 비었을 때 다시 하세요.`);
          process.exitCode = 2;
          break;
        }
      }
      dry(restartNeeded ? "코드 교체와 게이트 재시작" : "코드 교체");
      if (options.write) {
        if (!copied) {
          if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
          fs.copyFileSync(source, `${target}.tmp`);
          fs.renameSync(`${target}.tmp`, target);
        }
        if (restartNeeded) {
          const result = await run("systemctl", ["--user", "restart", `bweeep-gate@${unitName}`]);
          say(result.ok ? "다시 시작했습니다. 켜져 있던 서버는 그대로 이어집니다." : `다시 시작 실패: ${result.out}`);
        }
      }
      break;
    }
    default:
      throw new Error("명령: show | apply | clear | reload | open | close-by-hand | install");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
