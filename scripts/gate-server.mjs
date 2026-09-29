#!/usr/bin/env node
// Puts one Minecraft server behind the server gate (scripts/server-gate.mjs):
// the gate takes over the server's public port, the server moves to
// 127.0.0.1:<port + 10000>, and each server gets its own gate process
// (bweeep-gate@<unit>.service), so adding or updating one never drops players
// on another. Default is a dry run; --apply refuses while anyone is on the
// server. See --help.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeStatus, readConfig } from "./server-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_SOURCE = path.join(REPO, "scripts", "server-gate.mjs");
const SYSTEMD_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const TEMPLATE = "bweeep-gate@.service";
const BACKEND_OFFSET = 10000;

const HELP = `사용법: node scripts/gate-server.mjs --dir <서버 폴더> --unit <systemd 유닛> [옵션]

빈 서버를 재웠다가 누가 들어오면 바로 깨우는 "서버 게이트"를 이 서버 앞에 둡니다.
기본은 dry-run: 바꿀 내용만 출력합니다.

--apply 가 하는 일 (접속자가 있으면 하지 않음)
  1) 서버 유닛을 멈춤 (월드 저장)
  2) server.properties 백업 후 server-port/query.port=<공개 포트+${BACKEND_OFFSET}>, server-ip=127.0.0.1
  3) <gate-dir>/server-gate.mjs 를 저장소 것으로 맞추고 <gate-dir>/<유닛>.json 작성
  4) ${TEMPLATE} 가 없으면 만들고, 서버 유닛은 부팅 때 켜지지 않게(disable), 게이트는 켜지게(enable)
  5) 게이트 시작 후 서버를 다시 켬. 이후 --idle-minutes 동안 아무도 없으면 게이트가 끔

옵션
  --idle-minutes <n>   빈 채로 이만큼 지나면 끔 (기본 10)
  --name <이름>        잠든 동안 상태 응답에 쓸 이름 (기본 폴더 이름)
  --gate-dir <path>    게이트 파일 폴더 (기본 /home/dev/servers/bweeep-gate)
  --update-gate        이미 게이트 뒤에 있는 서버: 게이트 코드만 새로 복사하고 게이트만 재시작 (접속자 없을 때)
  --apply              실제로 바꿈

되돌리기: systemctl --user disable --now bweeep-gate@<유닛>, 백업한 server.properties 복원,
          systemctl --user enable --now <유닛>`;

function parseArgs(argv) {
  const out = { idleMinutes: 10, gateDir: "/home/dev/servers/bweeep-gate", apply: false, updateGate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (!argv[index + 1]) throw new Error(`${arg} 값이 없습니다.`);
      return argv[++index];
    };
    if (arg === "--dir") out.dir = path.resolve(value());
    else if (arg === "--unit") out.unit = value().replace(/\.service$/, "");
    else if (arg === "--idle-minutes") out.idleMinutes = Number(value());
    else if (arg === "--name") out.name = value();
    else if (arg === "--gate-dir") out.gateDir = path.resolve(value());
    else if (arg === "--update-gate") out.updateGate = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return out;
}

const systemctl = (...args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const isActive = (unit) => { try { return systemctl("is-active", unit) === "active"; } catch { return false; } };
const readProperty = (text, key) => new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=(.*)$`, "m").exec(text)?.[1].trim() ?? null;
function writeProperty(text, key, value) {
  const pattern = new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=.*$`, "m");
  return pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`;
}
const listening = () => execFileSync("ss", ["-ltnH"], { encoding: "utf8" });
const portBusy = (port) => new RegExp(`[:.]${port}\\s`).test(listening());
const step = (text) => console.log(`- ${text}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (!args.dir || !args.unit) throw new Error("--dir 와 --unit 이 필요합니다. --help 참고");
  if (!/^[\w@.-]+$/.test(args.unit)) throw new Error("유닛 이름이 올바르지 않습니다.");
  if (!(args.idleMinutes > 0)) throw new Error("--idle-minutes 가 올바르지 않습니다.");
  const configFile = path.join(args.gateDir, `${args.unit}.json`);
  const gateUnit = `bweeep-gate@${args.unit}`;
  const propsFile = path.join(args.dir, "server.properties");
  const props = fs.readFileSync(propsFile, "utf8");
  const existing = fs.existsSync(configFile) ? readConfig(configFile).servers[0] : null;

  console.log(`${args.apply ? "적용 모드" : "dry-run (아무것도 바꾸지 않음)"}: ${args.unit} (${args.dir})`);
  const publicPort = existing?.listen ?? Number(readProperty(props, "server-port") ?? 25565);
  const backendPort = existing?.backend ?? publicPort + BACKEND_OFFSET;
  step(`공개 포트 ${publicPort} (게이트), 서버 포트 127.0.0.1:${backendPort}`);

  // Anyone on it? Ask through the public port: the gate or the server itself answers.
  const status = await probeStatusOn(publicPort);
  const online = status?.players?.online ?? 0;
  step(status ? `지금 접속자 ${online}명` : "지금 상태 응답 없음 (꺼져 있음)");
  if (args.apply && online > 0) throw new Error("접속자가 있어서 멈춥니다. 모두 나간 뒤 다시 실행하세요.");

  if (args.updateGate) {
    if (!existing) throw new Error(`${configFile} 가 없습니다. 먼저 --update-gate 없이 게이트 뒤에 두세요.`);
    step(`게이트 코드 갱신 후 ${gateUnit} 재시작`);
    if (!args.apply) return console.log("\ndry-run: 실제로 하려면 --apply");
    fs.copyFileSync(GATE_SOURCE, path.join(args.gateDir, "server-gate.mjs"));
    systemctl("restart", gateUnit);
    return console.log("완료");
  }
  if (existing) {
    step(`이미 게이트 뒤에 있습니다 (${configFile}). 코드만 바꾸려면 --update-gate`);
    return;
  }
  if (portBusy(backendPort)) throw new Error(`포트 ${backendPort} 를 이미 누가 쓰고 있습니다.`);

  const nextProps = [["server-port", backendPort], ["query.port", backendPort], ["server-ip", "127.0.0.1"]]
    .reduce((text, [key, value]) => writeProperty(text, key, value), props);
  const entry = { name: args.name ?? path.basename(args.dir), unit: args.unit, listen: publicPort, backend: backendPort, idleMinutes: args.idleMinutes };
  const config = { stateDir: path.join(os.homedir(), ".local", "state", "bweeep-gate"), servers: [entry] };
  const template = `[Unit]
Description=Bweeep server gate %i (sleeps the server when empty, wakes it on join)
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${path.join(args.gateDir, "server-gate.mjs")} --config ${path.join(args.gateDir, "%i.json")}
Restart=always
RestartSec=2
MemoryMax=256M

[Install]
WantedBy=default.target
`;
  step(`${args.unit} 멈춤 → server.properties 백업 후 포트 변경 → ${configFile} 작성`);
  step(`${TEMPLATE} ${fs.existsSync(path.join(SYSTEMD_DIR, TEMPLATE)) ? "유지" : "만듦"}, ${args.unit} disable, ${gateUnit} enable --now, ${args.unit} start`);
  step(`빈 채로 ${args.idleMinutes}분이면 끔`);
  if (!args.apply) return console.log("\ndry-run: 실제로 하려면 --apply");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const wasActive = isActive(args.unit);
  if (wasActive) systemctl("stop", args.unit);
  fs.copyFileSync(propsFile, `${propsFile}.bak-gate-${stamp}`);
  fs.writeFileSync(propsFile, nextProps);
  fs.mkdirSync(args.gateDir, { recursive: true });
  fs.copyFileSync(GATE_SOURCE, path.join(args.gateDir, "server-gate.mjs"));
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  readConfig(configFile);
  if (!fs.existsSync(path.join(SYSTEMD_DIR, TEMPLATE))) fs.writeFileSync(path.join(SYSTEMD_DIR, TEMPLATE), template);
  systemctl("daemon-reload");
  systemctl("disable", args.unit);
  systemctl("enable", "--now", gateUnit);
  systemctl("start", args.unit);
  console.log(`완료. 백업: ${propsFile}.bak-gate-${stamp}`);
  console.log(`확인: journalctl --user -u ${gateUnit} -f`);
}

function probeStatusOn(port) {
  return probeStatus(port, 3000);
}

main().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exit(1);
});
