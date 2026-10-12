#!/usr/bin/env node
// Sends a notice to every player on one server: the bweeep-notify client mod
// shows it as a banner with a ding. The server needs no mod; the notice is a
// vanilla `tellraw` system message with the translate key "bweeep.notice",
// sent over the server's RCON with the password the server gate already holds
// (/home/dev/servers/bweeep-gate/<unit>.json). Players without the mod see the
// `fallback` text in chat. Default is a dry run; --send really sends.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, rconCommand } from "./server-gate.mjs";

export const NOTICE_KEY = "bweeep.notice";
export const LEVELS = ["info", "success", "warning", "urgent"];
export const MAX_TEXT = 100;
export const MIN_SECONDS = 2;
export const MAX_SECONDS = 30;
const DEFAULT_GATE_DIR = "/home/dev/servers/bweeep-gate";
const FALLBACK = "[공지] %3$s";
const ELLIPSIS = "…";

const HELP = `사용법: node scripts/bweeep-notify.mjs <서버 유닛> <등급> <문구> [--seconds N] [--send] [--gate-dir 폴더]

접속 중인 모든 플레이어 화면에 알림 배너를 띄웁니다(붸에엡 알림 모드가 있는 클라이언트).
기본은 dry-run: 보낼 명령만 출력하고 서버에는 아무것도 보내지 않습니다. --send 로 실제 전송합니다.

  <서버 유닛>   예: bweeep-society-server (게이트 설정 <게이트 폴더>/<유닛>.json 의 RCON 을 씁니다)
  <등급>        ${LEVELS.join(" | ")}
  <문구>        최대 ${MAX_TEXT}자(넘으면 … 로 줄임). 서식 코드·제어 문자는 지웁니다.
  --seconds N   배너가 열려 있는 시간(${MIN_SECONDS}-${MAX_SECONDS}초). 없으면 5초
  --send        실제로 보냅니다
  --gate-dir    게이트 설정 폴더(기본 ${DEFAULT_GATE_DIR})

모드가 없는 클라이언트에는 채팅에 "[공지] 문구"로 보입니다.`;

/** Same rules as the mod's NoticeText.sanitize, so what is sent is what is shown. */
export function sanitizeText(raw, max = MAX_TEXT) {
  const out = [];
  let pendingSpace = false;
  const chars = Array.from(String(raw ?? ""));
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === "§") {
      i += 1; // the formatting code character after the section sign
      continue;
    }
    if (/^[\s\p{Z}]$/u.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (/^[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}]$/u.test(ch)) continue;
    if (pendingSpace) {
      out.push(" ");
      pendingSpace = false;
    }
    out.push(ch);
  }
  if (out.length <= max) return out.join("");
  return out.slice(0, max - 1).join("").trimEnd() + ELLIPSIS;
}

/** @returns {number} 0 for the mod's default, otherwise whole seconds in range */
export function normalizeSeconds(value) {
  if (value === undefined || value === null || value === "") return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds 는 0보다 큰 숫자여야 합니다.");
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(seconds)));
}

/** The console command; pure ASCII so no charset between here and the server can change it. */
export function buildNoticeCommand({ level, seconds, text }) {
  if (!LEVELS.includes(level)) throw new Error(`등급은 ${LEVELS.join(", ")} 중 하나여야 합니다.`);
  const clean = sanitizeText(text);
  if (!clean) throw new Error("문구가 비어 있습니다.");
  const component = { translate: NOTICE_KEY, fallback: FALLBACK, with: [level, String(normalizeSeconds(seconds)), clean] };
  const json = JSON.stringify(component).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return { command: `tellraw @a ${json}`, text: clean, truncated: clean !== sanitizeText(text, Infinity) };
}

export function loadRcon(unit, gateDir = DEFAULT_GATE_DIR) {
  if (!/^[\w@-][\w@.-]*$/.test(unit)) throw new Error("서버 유닛 이름이 올바르지 않습니다.");
  const file = path.join(gateDir, `${unit}.json`);
  if (!fs.existsSync(file)) throw new Error(`게이트 설정이 없습니다: ${file}`);
  const entry = readConfig(file).servers.find((server) => server.unit === unit);
  if (!entry) throw new Error(`${file} 에 ${unit} 항목이 없습니다.`);
  if (!entry.rcon) throw new Error(`${unit} 은 RCON 이 설정되어 있지 않습니다.`);
  return { name: entry.name ?? unit, port: entry.rcon.port, password: entry.rcon.password };
}

function parseArgs(argv) {
  const positional = [];
  const options = { send: false, seconds: undefined, gateDir: DEFAULT_GATE_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--send") options.send = true;
    else if (arg === "--seconds" || arg === "--gate-dir") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} 값이 필요합니다.`);
      if (arg === "--seconds") options.seconds = argv[(i += 1)];
      else options.gateDir = argv[(i += 1)];
    } else if (arg.startsWith("--")) throw new Error(`알 수 없는 옵션: ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

export async function main(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help || positional.length === 0) {
    console.log(HELP);
    return options.help ? 0 : 1;
  }
  if (positional.length !== 3) throw new Error("서버 유닛, 등급, 문구 세 가지가 필요합니다. 문구에 공백이 있으면 따옴표로 묶으세요.");
  const [unit, level, rawText] = positional;
  const rcon = loadRcon(unit, options.gateDir);
  const { command, text, truncated } = buildNoticeCommand({ level, seconds: options.seconds, text: rawText });
  if (truncated) console.log(`문구가 ${MAX_TEXT}자를 넘어 줄였습니다: ${text}`);
  console.log(`서버: ${rcon.name} (${unit}), RCON 127.0.0.1:${rcon.port}`);
  console.log(`명령: ${command}`);
  if (!options.send) {
    console.log("dry-run: 아무것도 보내지 않았습니다. 실제로 보내려면 --send 를 붙이세요.");
    return 0;
  }
  const reply = await rconCommand(rcon.port, rcon.password, command);
  if (reply === null) {
    console.error("서버에 보내지 못했습니다(꺼져 있거나 RCON 이 응답하지 않습니다).");
    return 1;
  }
  if (/no player was found|no entity was found/i.test(reply)) {
    console.log("보냈지만 접속 중인 플레이어가 없습니다.");
    return 0;
  }
  console.log(`보냈습니다.${reply ? ` (서버 응답: ${reply})` : ""}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
