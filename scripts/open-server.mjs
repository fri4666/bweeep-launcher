#!/usr/bin/env node
// Prepares a Minecraft server directory (new or existing, any loader) so
// players sign in with their Bweeep account: authlib-injector as a Java agent,
// online-mode on, a systemd user unit with a memory cap, old Bweeep login mods
// moved aside, and the identity SQL for players the world already knows.
// Default is a dry run that prints every change; --apply performs them after
// backing up each file it touches. It never starts, stops or restarts a
// server, and never touches firewall or router settings. See --help.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { validateForPublish } from "./publish-manifest.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_SOURCE = path.join(REPO, "resources", "authlib-injector", "authlib-injector-1.2.8.jar");
const DEFAULT_API_ROOT = "https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/yggdrasil";
const DEFAULT_SYSTEMD_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const DROP_IN = "yggdrasil.conf";
// Ports the Windows firewall already lets in (checked 2026-09-28). Any other
// port needs a firewall rule and a router forward that only the owner can add.
const KNOWN_OPEN_PORTS = [25565, 31234];
// Server-side login mods from before the Bweeep account API. authlib-injector replaces them.
const OLD_LOGIN_MODS = /^bweeep-server-auth.*\.jar$/i;
// Auth, login or skin mods and plugins that may fight authlib-injector over the login or skin lookup.
const CONFLICTING_MODS = /(easy-?auth|authme|nlogin|jpremium|librelogin|fastlogin|skinsrestorer|offlineskins|simple-?auth|loginsecurity|open-?login)/i;

const HELP = `사용법: node scripts/open-server.mjs --dir <서버 폴더> --port <포트> --unit <systemd 유닛> [옵션]

새 서버나 기존 서버 폴더를 붸에엡 계정 로그인(authlib-injector)용으로 준비합니다.
기본은 dry-run: 바꿀 내용을 모두 출력만 하고 아무것도 바꾸지 않습니다.
서버를 켜거나 끄거나 재시작하지 않고, 방화벽·공유기 설정도 건드리지 않습니다.

하는 일
  0) 사전 점검: 서버 종류, 포트 충돌, 남은 메모리 vs MemoryMax, 힙(-Xmx) vs MemoryMax,
     EULA, 로그인·스킨 모드 충돌, 플레이어 "이름"으로 데이터를 저장하는 모드 추정(휴리스틱)
  1) authlib-injector-1.2.8.jar 복사 후 sha256 확인 (값은 src/main/authlib-injector.ts)
  2) server.properties: server-port/query.port=<포트>, online-mode=true, enforce-secure-profile=false
  3) mods/bweeep-server-auth*.jar 를 mods-disabled/ 로 옮김
  4) systemd 유닛: 없으면 새로 만들고, 있으면 drop-in(${DROP_IN})으로
     JAVA_TOOL_OPTIONS=-javaagent:...authlib-injector...=<API> 와 MemoryMax 를 맞춤
  5) usercache.json 의 오프라인 UUID 플레이어 → 이름·UUID 예약 SQL (server-identity-import.mjs)
  6) 사람이 해야 할 일(방화벽/공유기, 재시작, 카탈로그 등록) 출력
  --apply 때는 바꾸기 전에 파일을 백업 폴더에 복사합니다.

필수
  --dir <path>          서버 폴더
  --port <n>            서버 포트
  --unit <name>         systemd 사용자 유닛 이름 (예: bweeep-society-server)

옵션
  --memory-max <크기>   유닛 MemoryMax (예: 8G). 새 유닛이면 필수, 기존 유닛은 주면 맞추고 안 주면 그대로
  --java <path>         새 유닛의 java (기본: <dir>/runtime/bin/java 가 있으면 그것)
  --xmx <크기>          새 -jar 유닛의 최대 힙 (기본: MemoryMax - 2G). Forge/NeoForge 는 user_jvm_args.txt 를 고침
  --exec "<명령>"       새 유닛의 ExecStart 를 직접 지정
  --owners <file>       server-identity-import.mjs 의 owners.json. 있으면 예약 SQL을 만듦
  --sql-out <file>      예약 SQL을 파일로 저장 (없으면 화면에 출력)
  --manifest <file>     이 서버의 manifest 를 publish-manifest 규칙으로 검사하고 포트·로더를 대조
  --api-root <url>      Yggdrasil API (기본 ${DEFAULT_API_ROOT})
  --systemd-dir <path>  유닛 폴더 (기본 ~/.config/systemd/user, 시험 때 복사본 지정)
  --backup-dir <path>   백업 폴더 (기본 <dir 의 상위>/backups/open-server-<폴더명>-<시각>)
  --no-scan             이름 저장 모드 추정 검사를 건너뜀
  --apply               실제로 바꿈
  -h, --help            이 도움말

예시
  node scripts/open-server.mjs --dir /home/dev/servers/society-sunlit-valley-4.1.5 --port 31234 \\
    --unit bweeep-society-server --memory-max 8G --manifest resources/manifests/society-sunlit-valley.json`;

const findings = { changes: 0, warnings: 0, errors: 0 };
const say = (tag, text) => console.log(`${tag.padEnd(4, " ")} ${text}`);
const change = (text) => { findings.changes += 1; say("변경", text); };
const same = (text) => say("유지", text);
const warn = (text) => { findings.warnings += 1; say("경고", text); };
const fail = (text) => { findings.errors += 1; say("오류", text); };
const info = (text) => say("정보", text);
const section = (title) => console.log(`\n== ${title}`);

let args;

async function main() {
  const dir = path.resolve(args.dir);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`서버 폴더가 없습니다: ${dir}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const backupDir = path.resolve(args.backupDir ?? path.join(path.dirname(dir), "backups", `open-server-${path.basename(dir)}-${stamp}`));
  const systemdDir = path.resolve(args.systemdDir);
  const realSystemd = systemdDir === DEFAULT_SYSTEMD_DIR;
  const agentTarget = path.join(dir, path.basename(AGENT_SOURCE));
  const agentOption = `-javaagent:${agentTarget}=${args.apiRoot}`;
  const actions = [];

  console.log(`${args.apply ? "적용 모드" : "dry-run (아무것도 바꾸지 않음)"}: ${dir}`);
  console.log(`포트 ${args.port}, 유닛 ${args.unit}.service (${systemdDir})`);

  // ---- 0. pre-flight
  section("0. 사전 점검");
  const server = detectServer(dir);
  info(`서버 종류: ${server.kind}${server.version ? ` ${server.version}` : ""}${server.launch ? ` (${server.launch})` : ""}`);
  const propsPath = path.join(dir, "server.properties");
  const props = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : null;
  const levelName = (props && readProperty(props, "level-name")) || "world";
  const unit = readUnit(systemdDir, args.unit);
  const status = realSystemd && unit.exists ? unitStatus(args.unit) : null;
  if (unit.exists && unit.base.workingDirectory && path.resolve(unit.base.workingDirectory) !== dir) {
    throw new Error(`${args.unit} 유닛의 WorkingDirectory(${unit.base.workingDirectory})가 --dir 과 다릅니다. 다른 서버의 유닛입니다.`);
  }
  if (status) info(`유닛 상태: ${status.activeState}${status.memoryCurrent ? `, 사용 메모리 ${formatBytes(status.memoryCurrent)}` : ""}`);
  checkPort(dir, props, status);
  checkEula(dir);
  const memoryMax = args.memoryMax ?? unit.effective.memoryMax;
  const heap = args.xmx ??
    (server.jvmArgsFile ? readXmx(fs.readFileSync(server.jvmArgsFile, "utf8"))
      : unit.exists ? readXmx(unit.base.execStart ?? "")
        : args.memoryMax && server.jar ? defaultHeap(args.memoryMax) : null);
  checkMemory({ memoryMax, status, heap, unitExists: unit.exists });
  checkJava(server, unit, args);
  checkConflictingMods(dir);
  const players = readPlayers(dir);
  if (!args.noScan) scanNameKeyedData(dir, levelName, players);

  // ---- 1. authlib-injector
  section("1. authlib-injector");
  const pinned = pinnedAgentSha256();
  const sourceHash = sha256File(AGENT_SOURCE);
  if (sourceHash !== pinned) throw new Error(`저장소의 authlib-injector 해시가 고정값과 다릅니다: ${sourceHash}`);
  const targetHash = fs.existsSync(agentTarget) ? sha256File(agentTarget) : null;
  if (targetHash === pinned) {
    same(`${agentTarget} (sha256 일치)`);
  } else {
    change(`${targetHash ? "해시가 다른 파일 교체" : "복사"}: ${AGENT_SOURCE} → ${agentTarget}`);
    actions.push({ backup: targetHash ? [agentTarget] : [], created: targetHash ? null : agentTarget, run: () => {
      copyAtomic(AGENT_SOURCE, agentTarget);
      if (sha256File(agentTarget) !== pinned) throw new Error("복사한 authlib-injector 해시가 다릅니다.");
    } });
  }

  // ---- 2. server.properties
  section("2. server.properties");
  const desiredProps = [
    ["server-port", String(args.port)],
    ["query.port", String(args.port)],
    ["online-mode", "true"],
    ["enforce-secure-profile", "false"]
  ];
  const currentPort = props && readProperty(props, "server-port");
  if (currentPort && currentPort !== String(args.port)) {
    warn(`포트를 ${currentPort} → ${args.port} 로 바꿉니다. manifest 의 server.port 와 방화벽도 함께 바꿔야 합니다.`);
  }
  let nextProps = props ?? "";
  for (const [key, value] of desiredProps) {
    const current = readProperty(nextProps, key);
    if (current === value) {
      same(`${key}=${value}`);
    } else {
      change(`${key}: ${current ?? "(없음)"} → ${value}`);
      nextProps = writeProperty(nextProps, key, value);
    }
  }
  if (!props) info("server.properties 가 없어 위 4줄로 새로 만듭니다. 나머지는 서버가 처음 켜질 때 채웁니다.");
  if (nextProps !== (props ?? "")) {
    actions.push({ backup: props ? [propsPath] : [], created: props ? null : propsPath, run: () => writeAtomic(propsPath, nextProps) });
  }

  // ---- 3. old Bweeep login mods
  section("3. 예전 붸에엡 로그인 모드");
  const modsDir = path.join(dir, "mods");
  const oldMods = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((name) => OLD_LOGIN_MODS.test(name)) : [];
  if (!oldMods.length) same("mods/ 에 bweeep-server-auth*.jar 없음");
  for (const name of oldMods) {
    const disabledDir = path.join(dir, "mods-disabled");
    let target = path.join(disabledDir, name);
    if (fs.existsSync(target)) target = path.join(disabledDir, `${name}.${stamp}`);
    change(`옮김: mods/${name} → ${path.relative(dir, target)}`);
    actions.push({ backup: [], run: () => {
      fs.mkdirSync(disabledDir, { recursive: true });
      fs.renameSync(path.join(modsDir, name), target);
    }, undo: `mv '${target}' '${path.join(modsDir, name)}'` });
  }

  // ---- 4. systemd unit
  section(`4. systemd 유닛 ${args.unit}.service`);
  const unitActions = planUnit({ unit, dir, server, agentOption, systemdDir });
  actions.push(...unitActions);

  // ---- 5. identities
  section("5. 기존 플레이어 이름·UUID 예약");
  planIdentities(dir, players);

  // ---- manifest hand-off
  if (args.manifest) {
    section("카탈로그 manifest");
    checkManifest(args.manifest, server);
  }

  // ---- apply
  if (args.apply && findings.errors) {
    section("적용 안 함");
    say("오류", `오류 ${findings.errors}개가 있어 아무것도 바꾸지 않았습니다. 위 오류를 고친 뒤 다시 실행하세요.`);
    process.exit(1);
  }
  if (args.apply && actions.length) {
    section("적용");
    // Every file is copied before anything is changed, so a failed step leaves a complete backup.
    const restore = [];
    for (const action of actions) {
      for (const file of action.backup) {
        const rel = file.startsWith(dir + path.sep) ? path.join("server", path.relative(dir, file)) : path.join("systemd", path.relative(systemdDir, file));
        const copy = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.copyFileSync(file, copy);
        restore.push(`cp -p '${copy}' '${file}'`);
      }
      if (action.undo) restore.push(action.undo);
      if (action.created) restore.push(`rm '${action.created}'`);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "README.txt"), [
      `open-server.mjs ${new Date().toISOString()}`,
      `server: ${dir}`,
      `unit: ${args.unit}.service (${systemdDir})`,
      "",
      "되돌리기 (서버를 끈 상태에서, 끝나면 systemctl --user daemon-reload):",
      ...restore
    ].join("\n") + "\n");
    info(`백업과 되돌리기 방법: ${backupDir}/README.txt`);
    for (const action of actions) action.run();
    if (realSystemd && unitActions.length) {
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      info("systemctl --user daemon-reload 완료 (서버는 재시작하지 않았습니다)");
    }
    say("완료", `${actions.length}개 작업을 적용했습니다.`);
  }

  // ---- manual steps
  section("6. 사람이 할 일");
  manualSteps({ unit, status, realSystemd, unitChanged: unitActions.length > 0 });

  console.log(`\n요약: 변경 ${findings.changes}, 경고 ${findings.warnings}, 오류 ${findings.errors}${args.apply ? "" : " (dry-run: 아무것도 바꾸지 않았습니다. 실제로 하려면 --apply)"}`);
  if (findings.errors) process.exit(1);
}

// ---------------------------------------------------------------- detection

function detectServer(dir) {
  const forge = findArgsFile(dir, ["net", "minecraftforge", "forge"]);
  if (forge) return { kind: "forge", ...forge };
  const neoforge = findArgsFile(dir, ["net", "neoforged", "neoforge"]);
  if (neoforge) return { kind: "neoforge", ...neoforge };
  if (fs.existsSync(path.join(dir, "fabric-server-launch.jar"))) return { kind: "fabric", launch: "fabric-server-launch.jar", jar: "fabric-server-launch.jar" };
  const paper = fs.readdirSync(dir).find((name) => /^(paper|purpur|folia)[-\w.]*\.jar$/i.test(name));
  if (paper) return { kind: "paper", launch: paper, jar: paper };
  if (fs.existsSync(path.join(dir, "server.jar"))) return { kind: "vanilla", launch: "server.jar", jar: "server.jar" };
  return { kind: "unknown" };
}

function findArgsFile(dir, parts) {
  const base = path.join(dir, "libraries", ...parts);
  if (!fs.existsSync(base)) return null;
  for (const version of fs.readdirSync(base).sort().reverse()) {
    const argsFile = path.join(base, version, "unix_args.txt");
    if (fs.existsSync(argsFile)) {
      const jvmArgsFile = path.join(dir, "user_jvm_args.txt");
      return {
        version,
        launch: `@user_jvm_args.txt @${path.relative(dir, argsFile)} nogui`,
        jvmArgsFile: fs.existsSync(jvmArgsFile) ? jvmArgsFile : null,
        minecraftVersion: version.split("-")[0]
      };
    }
  }
  return null;
}

/** The Java feature release each Minecraft version needs, for a sanity check of --java. */
function requiredJava(minecraftVersion) {
  if (!minecraftVersion) return null;
  const [major, minor = 0, patch = 0] = minecraftVersion.split(".").map(Number);
  if (major >= 26) return 25;
  if (major !== 1) return null;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

// ---------------------------------------------------------------- pre-flight checks

function checkPort(dir, props, status) {
  if (!KNOWN_OPEN_PORTS.includes(args.port)) warn(`${args.port} 은 Windows 방화벽에 열린 포트(${KNOWN_OPEN_PORTS.join(", ")})가 아닙니다. 6번의 수동 작업이 필요합니다.`);
  const parent = path.dirname(dir);
  for (const name of fs.readdirSync(parent)) {
    const other = path.join(parent, name);
    if (other === dir) continue;
    const file = path.join(other, "server.properties");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (readProperty(text, "server-port") === String(args.port)) fail(`${other} 도 server-port=${args.port} 입니다. 동시에 켜면 충돌합니다.`);
  }
  const listening = listeningPorts();
  if (listening === null) {
    info("ss 가 없어 사용 중인 포트는 확인하지 못했습니다.");
  } else if (listening.has(args.port)) {
    if (status?.activeState === "active" && props && readProperty(props, "server-port") === String(args.port)) {
      same(`포트 ${args.port} 는 이 서버(${args.unit})가 쓰는 중`);
    } else {
      warn(`포트 ${args.port} 를 이미 어떤 프로세스가 쓰고 있습니다. 이 서버 자신이 아니라면 다른 포트를 고르세요.`);
    }
  } else {
    same(`포트 ${args.port} 는 비어 있음`);
  }
}

function listeningPorts() {
  const result = spawnSync("ss", ["-Hltn"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const ports = new Set();
  for (const line of result.stdout.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const port = Number(local?.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

function checkEula(dir) {
  const file = path.join(dir, "eula.txt");
  const accepted = fs.existsSync(file) && /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(file, "utf8"));
  if (accepted) same("eula.txt: eula=true");
  else warn("eula.txt 에 eula=true 가 없습니다. Minecraft EULA 동의는 서버 주인이 직접 해야 합니다(스크립트는 바꾸지 않음).");
}

function checkMemory({ memoryMax, status, heap, unitExists }) {
  const meminfo = Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((line) => {
    const [key, value] = line.split(":");
    return [key, Number.parseInt(value, 10) * 1024];
  }));
  const available = meminfo.MemAvailable;
  const freed = status?.activeState === "active" ? status.memoryCurrent ?? 0 : 0;
  info(`메모리: 전체 ${formatBytes(meminfo.MemTotal)}, 지금 사용 가능 ${formatBytes(available)}${freed ? ` (+ 이 서버가 쓰는 ${formatBytes(freed)})` : ""}`);
  if (!memoryMax) {
    if (unitExists) warn("유닛에 MemoryMax 가 없습니다. 서버가 WSL 메모리를 다 쓰면 다른 서버까지 멈춥니다. --memory-max 를 주세요.");
    else fail("새 유닛에는 --memory-max 가 필요합니다.");
    return;
  }
  const limit = parseSize(memoryMax);
  if (limit > available + freed) {
    warn(`MemoryMax ${memoryMax} 가 지금 남은 메모리(${formatBytes(available + freed)})보다 큽니다. 다른 서버와 게임을 켠 채로 이 서버가 한도까지 쓰면 WSL 이 멈출 수 있습니다.`);
  } else {
    same(`MemoryMax ${memoryMax} ≤ 사용 가능 ${formatBytes(available + freed)}`);
  }
  if (limit > meminfo.MemTotal * 0.8) warn(`MemoryMax ${memoryMax} 가 WSL 전체 메모리의 80%를 넘습니다.`);
  if (heap) {
    const heapBytes = parseSize(heap);
    if (heapBytes + 1024 ** 3 > limit) warn(`최대 힙 -Xmx${heap} + 여유 1G 가 MemoryMax ${memoryMax} 보다 큽니다. 서버가 한도에 걸려 강제 종료될 수 있습니다.`);
    else same(`최대 힙 ${heap} + 여유 1G ≤ MemoryMax ${memoryMax}`);
  } else if (unitExists) {
    info("최대 힙(-Xmx)을 찾지 못했습니다.");
  }
}

function checkJava(server, unit, options) {
  const java = options.java ?? (unit.exists ? unit.base.execStart?.split(/\s+/)[0] : null) ?? defaultJava(path.resolve(options.dir));
  if (!java) {
    if (!unit.exists && !options.exec) fail("java 경로를 모릅니다. --java 를 주세요.");
    return;
  }
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  const major = Number(/version "(?:1\.)?(\d+)/.exec(`${result.stderr}${result.stdout}`)?.[1]);
  if (!Number.isInteger(major)) {
    (unit.exists ? warn : fail)(`java 를 실행하지 못했습니다: ${java}`);
    return;
  }
  const need = requiredJava(server.minecraftVersion);
  if (need && major < need) fail(`${java} 는 Java ${major} 입니다. Minecraft ${server.minecraftVersion} 은 Java ${need} 이상이 필요합니다.`);
  else same(`java: ${java} (Java ${major}${need ? `, 필요 ${need}` : ""})`);
}

function defaultJava(dir) {
  const bundled = path.join(dir, "runtime", "bin", "java");
  return fs.existsSync(bundled) ? bundled : null;
}

function checkConflictingMods(dir) {
  const hits = [];
  for (const folder of ["mods", "plugins"]) {
    const full = path.join(dir, folder);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (CONFLICTING_MODS.test(name) && !OLD_LOGIN_MODS.test(name)) hits.push(`${folder}/${name}`);
    }
  }
  if (hits.length) warn(`로그인·스킨을 직접 다루는 모드/플러그인이 있습니다. authlib-injector 와 부딪힐 수 있으니 확인하세요: ${hits.join(", ")}`);
  else same("로그인·스킨 충돌 모드 없음 (이름 목록으로만 확인)");
}

// ---------------------------------------------------------------- players and name-keyed data

function offlineUuid(name) {
  const hash = crypto.createHash("md5").update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every name/UUID pair the server has seen, from usercache, Forge's usernamecache, ops and the whitelist. */
function readPlayers(dir) {
  const usercache = readJson(path.join(dir, "usercache.json"));
  const entries = Array.isArray(usercache) ? usercache.filter((entry) => typeof entry?.name === "string" && typeof entry?.uuid === "string") : [];
  const known = new Map();
  const add = (name, uuid) => {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return;
    const list = known.get(name.toLowerCase()) ?? { name, uuids: new Set() };
    if (uuid) list.uuids.add(uuid.toLowerCase());
    known.set(name.toLowerCase(), list);
  };
  for (const entry of entries) add(entry.name, entry.uuid);
  const usernamecache = readJson(path.join(dir, "usernamecache.json"));
  if (usernamecache && typeof usernamecache === "object") for (const [uuid, name] of Object.entries(usernamecache)) add(String(name), uuid);
  for (const file of ["ops.json", "whitelist.json"]) {
    const list = readJson(path.join(dir, file));
    if (Array.isArray(list)) for (const entry of list) if (entry?.name) add(entry.name, entry.uuid);
  }
  return { usercache: entries, known };
}

// Keys that suggest a config or data file refers to players by name.
const NAME_KEY = /["']?\b(player_?name|user_?name|owner_?name|playerName|ownerName|userName|players?_?names?)\b["']?\s*[:=]/i;
const TEXT_FILE = /\.(json5?|toml|cfg|conf|properties|ya?ml|txt|snbt|js|csv|ini|xml)$/i;
const NBT_FILE = /\.(dat|nbt|dat_old)$/i;
const SKIP_DIRS = new Set(["region", "entities", "poi", "DIM-1", "DIM1", "dimensions", "libraries", "versions", "runtime", "mods", "mods-disabled", "logs", "crash-reports", "backups", ".mixin.out", "assets", "textures", "sounds", "models", "cache", ".cache"]);
const VANILLA_PLAYER_FILES = new Set(["usercache.json", "usernamecache.json", "ops.json", "whitelist.json", "banned-players.json", "banned-ips.json"]);

/**
 * Heuristic only: looks for files named after a known player, and files that
 * mention a player's name (but not their UUID) or use name-like keys. A mod
 * that stores data by name keeps it under the old name when a player's name
 * changes, and lets whoever takes that name later inherit it.
 */
function scanNameKeyedData(dir, levelName, players) {
  const names = [...players.known.values()].filter((player) => player.name.length >= 3);
  // The world root is walked for mod data (ftbquests, serverconfig, data/*.dat …) but not chunks or vanilla player files.
  const roots = ["config", "defaultconfigs", "kubejs", "plugins", "local", levelName]
    .map((rel) => path.join(dir, rel)).filter((full) => fs.existsSync(full));
  const topLevel = fs.readdirSync(dir).filter((name) => TEXT_FILE.test(name) && !VANILLA_PLAYER_FILES.has(name) && name !== "server.properties");
  const named = [];
  const mentions = [];
  const keyed = [];
  const budget = { files: 0, bytes: 0 };
  const matchers = names.map((player) => ({ player, pattern: new RegExp(`(^|[^A-Za-z0-9_])${player.name}([^A-Za-z0-9_]|$)`, "i") }));

  const inspect = (file) => {
    if (budget.files >= 20000 || budget.bytes >= 300 * 1024 ** 2) return;
    const rel = path.relative(dir, file);
    const base = path.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
    const namedAfter = names.find((player) => base === player.name.toLowerCase());
    if (namedAfter) named.push(`${rel} (${namedAfter.name})`);
    const isText = TEXT_FILE.test(file);
    const isNbt = NBT_FILE.test(file);
    if (!isText && !isNbt) return;
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 ** 2) return;
    budget.files += 1;
    budget.bytes += stat.size;
    let data;
    try {
      const raw = fs.readFileSync(file);
      data = isNbt && raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    } catch {
      return;
    }
    const text = data.toString(isNbt ? "latin1" : "utf8");
    const lower = `${rel}\n${text}`.toLowerCase();
    // A file that also carries the player's UUID (in its path, as text, or as NBT's
    // four-int array) most likely keys by UUID and only shows the name.
    const hasUuid = (uuid) => lower.includes(uuid) || lower.includes(uuid.replaceAll("-", "")) ||
      (isNbt && data.includes(Buffer.from(uuid.replaceAll("-", ""), "hex")));
    const hits = matchers.filter(({ player, pattern }) => pattern.test(text) && ![...player.uuids].some(hasUuid));
    if (hits.length) mentions.push(`${rel}: ${hits.map(({ player }) => player.name).join(", ")}`);
    else if (isText && NAME_KEY.test(text)) keyed.push(rel);
  };
  const walk = (full, depth) => {
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.join(full, entry.name);
      if (entry.isDirectory()) {
        const namedDir = names.find((player) => entry.name.toLowerCase() === player.name.toLowerCase());
        if (namedDir) named.push(`${path.relative(dir, child)}/ (${namedDir.name})`);
        if (!SKIP_DIRS.has(entry.name) && depth < 8) walk(child, depth + 1);
      } else if (entry.isFile()) {
        inspect(child);
      }
    }
  };
  for (const root of roots) walk(root, 0);
  for (const name of topLevel) inspect(path.join(dir, name));

  info(`이름 저장 추정 검사(휴리스틱): 플레이어 이름 ${names.length}개, 파일 ${budget.files}개 확인`);
  if (!names.length) info("알려진 플레이어 이름이 없어 이름 일치 검사는 못 했고, 이름 같은 키만 찾았습니다.");
  const list = (items, max = 25) => items.slice(0, max).map((item) => `\n       - ${item}`).join("") + (items.length > max ? `\n       … 외 ${items.length - max}개` : "");
  if (named.length) warn(`플레이어 이름으로 된 파일/폴더가 있습니다. 이름으로 데이터를 저장하는 모드일 가능성이 큽니다:${list(named)}`);
  if (mentions.length) warn(`플레이어 이름은 있는데 그 UUID 는 없는 파일입니다. 이름 기준 데이터일 수 있습니다:${list(mentions)}`);
  if (keyed.length) info(`이름 같은 키(playerName, username, owner_name …)가 있는 설정 파일 ${keyed.length}개 (대부분 무해, 참고용):${list(keyed, 5)}`);
  if (!named.length && !mentions.length) same("이름으로 저장된 데이터 흔적을 찾지 못했습니다 (휴리스틱이라 없다는 보장은 아님)");
}

// ---------------------------------------------------------------- systemd

function readUnit(systemdDir, name) {
  const file = path.join(systemdDir, `${name}.service`);
  const dropInDir = path.join(systemdDir, `${name}.service.d`);
  const exists = fs.existsSync(file);
  const dropIns = fs.existsSync(dropInDir) ? fs.readdirSync(dropInDir).filter((entry) => entry.endsWith(".conf")).sort() : [];
  const base = { environment: new Map(), memoryMax: null, memorySwapMax: null, execStart: null, workingDirectory: null };
  const sources = [exists ? file : null, ...dropIns.filter((entry) => entry !== DROP_IN).map((entry) => path.join(dropInDir, entry))].filter(Boolean);
  for (const source of sources) applyUnitFile(base, fs.readFileSync(source, "utf8"));
  const ownFile = path.join(dropInDir, DROP_IN);
  const own = { environment: new Map(), memoryMax: null, memorySwapMax: null, execStart: null, workingDirectory: null };
  const ownExists = fs.existsSync(ownFile);
  if (ownExists) applyUnitFile(own, fs.readFileSync(ownFile, "utf8"));
  const effective = {
    javaToolOptions: own.environment.get("JAVA_TOOL_OPTIONS") ?? base.environment.get("JAVA_TOOL_OPTIONS") ?? null,
    memoryMax: own.memoryMax ?? base.memoryMax
  };
  return { file, dropInDir, ownFile, exists, ownExists, base, own, effective, dropIns };
}

/** Reads the [Service] settings this script cares about, later assignments winning like systemd. */
function applyUnitFile(target, text) {
  let sectionName = "";
  const lines = text.replace(/\\\n/g, " ").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      sectionName = header[1];
      continue;
    }
    if (sectionName !== "Service") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "Environment") {
      if (!value) target.environment.clear();
      for (const [name, envValue] of parseEnvironment(value)) target.environment.set(name, envValue);
    } else if (key === "MemoryMax") target.memoryMax = value || null;
    else if (key === "MemorySwapMax") target.memorySwapMax = value || null;
    else if (key === "ExecStart") target.execStart = value || null;
    else if (key === "WorkingDirectory") target.workingDirectory = value || null;
  }
}

function parseEnvironment(value) {
  const pairs = [];
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    const token = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
    const eq = token.indexOf("=");
    if (eq > 0) pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
  }
  return pairs;
}

function environmentLine(name, value) {
  const assignment = `${name}=${value}`;
  return /[\s"'\\]/.test(assignment) ? `Environment="${assignment.replace(/(["\\])/g, "\\$1")}"` : `Environment=${assignment}`;
}

/** JAVA_TOOL_OPTIONS with our agent first and any other options the unit already had kept. */
function desiredJavaToolOptions(current, agentOption) {
  const others = (current ?? "").split(/\s+/).filter((token) => token && !/^-javaagent:.*authlib-injector[^=\s]*\.jar(=.*)?$/.test(token));
  return [agentOption, ...others].join(" ");
}

function sameSize(a, b) {
  if (!a || !b) return a === b;
  try {
    return parseSize(a) === parseSize(b);
  } catch {
    return a === b;
  }
}

function planUnit({ unit, dir, server, agentOption, systemdDir }) {
  const actions = [];
  if (!unit.exists) {
    const memoryMax = args.memoryMax;
    if (!memoryMax) {
      fail("새 유닛을 만들려면 --memory-max 가 필요합니다.");
      return actions;
    }
    const execStart = newExecStart(dir, server);
    if (!execStart) return actions;
    const content = [
      "# Written by scripts/open-server.mjs",
      "[Unit]",
      `Description=Bweeep ${path.basename(dir)} Minecraft server (port ${args.port})`,
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${dir}`,
      environmentLine("JAVA_TOOL_OPTIONS", agentOption),
      `ExecStart=${execStart}`,
      "Restart=on-failure",
      "RestartSec=10s",
      "KillSignal=SIGTERM",
      "TimeoutStopSec=180s",
      `MemoryMax=${memoryMax}`,
      "MemorySwapMax=0",
      "StandardOutput=journal",
      "StandardError=journal",
      "",
      "[Install]",
      "WantedBy=default.target",
      ""
    ].join("\n");
    change(`새 유닛 파일 ${unit.file}:\n${content.trimEnd().split("\n").map((line) => `       | ${line}`).join("\n")}`);
    actions.push({ backup: [], created: unit.file, run: () => {
      fs.mkdirSync(systemdDir, { recursive: true });
      writeAtomic(unit.file, content);
    } });
    if (server.jvmArgsFile && args.xmx) actions.push(...planJvmArgs(server.jvmArgsFile));
    return actions;
  }

  // Existing unit: the main file stays as it is; our drop-in overrides only what differs.
  info(`기존 유닛 ${unit.file}${unit.dropIns.length ? ` + drop-in ${unit.dropIns.join(", ")}` : ""}`);
  const baseJto = unit.base.environment.get("JAVA_TOOL_OPTIONS") ?? null;
  const wantJto = desiredJavaToolOptions(unit.effective.javaToolOptions, agentOption);
  const dropJto = baseJto === wantJto ? null : wantJto;
  const wantMemory = args.memoryMax ?? unit.effective.memoryMax;
  const dropMemory = wantMemory && !sameSize(wantMemory, unit.base.memoryMax) ? wantMemory : null;
  const dropSwap = dropMemory ? (unit.own.memorySwapMax ?? "0") : null;

  if (unit.effective.javaToolOptions === wantJto) same(`JAVA_TOOL_OPTIONS=${wantJto}`);
  else change(`JAVA_TOOL_OPTIONS: ${unit.effective.javaToolOptions ?? "(없음)"} → ${wantJto}`);
  if (sameSize(unit.effective.memoryMax, wantMemory)) {
    if (wantMemory) same(`MemoryMax=${wantMemory}`);
  } else {
    change(`MemoryMax: ${unit.effective.memoryMax ?? "(없음)"} → ${wantMemory}`);
  }

  const ownMatches = unit.ownExists
    ? (unit.own.environment.get("JAVA_TOOL_OPTIONS") ?? null) === dropJto && sameSize(unit.own.memoryMax, dropMemory) &&
      (dropMemory ? sameSize(unit.own.memorySwapMax, dropSwap) : true) && unit.own.environment.size === (dropJto ? 1 : 0)
    : !dropJto && !dropMemory;
  if (ownMatches) {
    same(unit.ownExists ? `drop-in ${DROP_IN} 내용 그대로` : `drop-in 필요 없음 (본 유닛 설정이 이미 맞음)`);
  } else if (!dropJto && !dropMemory) {
    change(`drop-in ${unit.ownFile} 삭제 (본 유닛 설정이 이미 맞음)`);
    actions.push({ backup: [unit.ownFile], run: () => fs.rmSync(unit.ownFile) });
  } else {
    const content = [
      "# Written by scripts/open-server.mjs: Bweeep account sign-in (authlib-injector)",
      "[Service]",
      ...(dropJto ? [environmentLine("JAVA_TOOL_OPTIONS", dropJto)] : []),
      ...(dropMemory ? [`MemoryMax=${dropMemory}`, `MemorySwapMax=${dropSwap}`] : []),
      ""
    ].join("\n");
    change(`drop-in ${unit.ownFile} ${unit.ownExists ? "갱신" : "생성"}:\n${content.trimEnd().split("\n").map((line) => `       | ${line}`).join("\n")}`);
    actions.push({ backup: unit.ownExists ? [unit.ownFile] : [], created: unit.ownExists ? null : unit.ownFile, run: () => {
      fs.mkdirSync(unit.dropInDir, { recursive: true });
      writeAtomic(unit.ownFile, content);
    } });
  }
  if (server.jvmArgsFile && args.xmx) actions.push(...planJvmArgs(server.jvmArgsFile));
  return actions;
}

function newExecStart(dir, server) {
  if (args.exec) return args.exec;
  const java = args.java ?? defaultJava(dir);
  if (!java) {
    fail("새 유닛의 java 를 모릅니다. --java 또는 --exec 를 주세요.");
    return null;
  }
  if (server.kind === "forge" || server.kind === "neoforge") {
    if (!server.jvmArgsFile) warn("user_jvm_args.txt 가 없습니다. 힙 크기를 정할 수 없습니다(--xmx 로 만들 수 있음).");
    return `${java} ${server.launch}`;
  }
  if (!server.jar) {
    fail("서버 실행 파일(server.jar, fabric-server-launch.jar, paper*.jar, Forge/NeoForge unix_args.txt)을 찾지 못했습니다. --exec 를 주세요.");
    return null;
  }
  const xmx = args.xmx ?? defaultHeap(args.memoryMax);
  return `${java} -Xms${halfSize(xmx)} -Xmx${xmx} -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -jar ${server.jar} nogui`;
}

function planJvmArgs(file) {
  const text = fs.readFileSync(file, "utf8");
  const current = readXmx(text);
  if (current && sameSize(current, args.xmx)) {
    same(`user_jvm_args.txt -Xmx${current}`);
    return [];
  }
  const next = current ? text.replace(/-Xmx\S+/, `-Xmx${args.xmx}`) : `${text.replace(/\n?$/, "\n")}-Xmx${args.xmx}\n`;
  change(`user_jvm_args.txt: -Xmx${current ?? "(없음)"} → -Xmx${args.xmx}`);
  return [{ backup: [file], run: () => writeAtomic(file, next) }];
}

function unitStatus(name) {
  const result = spawnSync("systemctl", ["--user", "show", `${name}.service`, "-p", "ActiveState", "-p", "MemoryCurrent"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=")));
  const memory = Number(values.MemoryCurrent);
  return { activeState: values.ActiveState, memoryCurrent: Number.isSafeInteger(memory) ? memory : null };
}

// ---------------------------------------------------------------- identities

function planIdentities(dir, players) {
  const entries = players.usercache;
  if (!entries.length) {
    same("usercache.json 에 플레이어가 없습니다. 예약할 것이 없습니다.");
    return;
  }
  const offline = entries.filter((entry) => offlineUuid(entry.name) === entry.uuid.toLowerCase());
  const other = entries.filter((entry) => offlineUuid(entry.name) !== entry.uuid.toLowerCase());
  info(`usercache: ${entries.length}명 중 오프라인 UUID ${offline.length}명, 그 밖의 UUID ${other.length}명`);
  if (other.length) info(`오프라인이 아닌 UUID(붸에엡 계정이나 정품 UUID, 가져올 대상 아님): ${other.map((entry) => entry.name).join(", ")}`);
  const byName = new Map();
  for (const entry of entries) byName.set(entry.name.toLowerCase(), [...(byName.get(entry.name.toLowerCase()) ?? []), entry.uuid]);
  for (const [, uuids] of byName) {
    const distinct = [...new Set(uuids.map((uuid) => uuid.toLowerCase()))];
    if (distinct.length > 1) {
      const name = entries.find((entry) => distinct.includes(entry.uuid.toLowerCase())).name;
      warn(`${name} 이(가) UUID ${distinct.length}개로 접속했습니다 (${distinct.join(", ")}). 캐릭터·인벤토리가 나뉘었을 수 있으니 확인하세요.`);
    }
  }
  if (!offline.length) return;
  info("이미 전환된 서버라면 이 오프라인 UUID 들은 대부분 예약되어 있습니다. SQL 은 다시 실행해도 바뀌는 것이 없습니다.");
  if (!args.owners) {
    info(`오프라인 UUID 플레이어: ${offline.map((entry) => entry.name).join(", ")}`);
    say("할일", "누가 어느 멤버인지 owners.json 을 만들고 --owners 로 다시 실행하면 예약 SQL 을 만듭니다 (형식: scripts/server-identity-import.mjs 맨 위 주석).");
    return;
  }
  // Only the offline entries are imported; the importer refuses any other UUID.
  // The filtered copy goes under ~/.cache, not /tmp (RAM on WSL).
  const work = path.join(os.homedir(), ".cache", "bweeep-open-server");
  fs.mkdirSync(work, { recursive: true });
  const filtered = path.join(work, `usercache-offline-${process.pid}.json`);
  fs.writeFileSync(filtered, JSON.stringify(offline));
  let result;
  try {
    result = spawnSync(process.execPath, [path.join(REPO, "scripts", "server-identity-import.mjs"), filtered, path.resolve(args.owners)], { encoding: "utf8" });
  } finally {
    fs.rmSync(filtered, { force: true });
  }
  if (result.status !== 0) {
    const output = `${result.stderr}${result.stdout}`;
    fail(`server-identity-import.mjs 실패: ${/Error: (.*)/.exec(output)?.[1] ?? output.trim().split("\n")[0]}`);
    return;
  }
  const statements = result.stdout.trim().split("\n").filter((line) => line.startsWith("insert")).length;
  if (args.sqlOut) {
    fs.writeFileSync(args.sqlOut, result.stdout);
    info(`예약 SQL (${statements}문장) 을 ${args.sqlOut} 에 썼습니다. 운영 DB 적용은 주인 허락 후 따로 합니다.`);
  } else {
    info(`예약 SQL (${statements}문장, 운영 DB 적용은 주인 허락 후 따로):`);
    console.log(result.stdout.trimEnd().split("\n").map((line) => `       ${line}`).join("\n"));
  }
}

// ---------------------------------------------------------------- manifest hand-off

function checkManifest(file, server) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const warning of validateForPublish(manifest)) warn(`manifest: ${warning}`);
  } catch (error) {
    fail(`manifest ${file}: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (manifest.server.port !== args.port) fail(`manifest server.port ${manifest.server.port} 가 --port ${args.port} 와 다릅니다.`);
  else same(`manifest server.port ${manifest.server.port}`);
  const serverKind = manifest.serverLoader?.kind ?? manifest.loader.kind;
  if (server.kind !== "unknown" && serverKind !== server.kind) warn(`manifest 서버 로더(${serverKind})와 폴더에서 찾은 서버(${server.kind})가 다릅니다.`);
  if (server.minecraftVersion && manifest.minecraftVersion !== server.minecraftVersion) {
    fail(`manifest minecraftVersion ${manifest.minecraftVersion} 와 서버 ${server.minecraftVersion} 이 다릅니다.`);
  }
  same(`manifest ${manifest.id} ${manifest.version} 검사 통과`);
  say("할일", `카탈로그 등록: node scripts/publish-manifest.mjs ${file}   (dry-run, 확인 후 --apply)`);
  say("할일", `서버 재시작·접속 확인 뒤 활성화: node scripts/publish-manifest.mjs ${file} --activate --apply`);
}

// ---------------------------------------------------------------- manual steps

function manualSteps({ unit, status, realSystemd, unitChanged }) {
  let step = 0;
  const todo = (text) => say(`${++step}.`, text);
  if (!KNOWN_OPEN_PORTS.includes(args.port)) {
    todo(`Windows 방화벽 (관리자 PowerShell, 주인이 직접):
       New-NetFirewallRule -DisplayName "Bweeep ${args.unit} ${args.port}" -Direction Inbound -Protocol TCP -LocalPort ${args.port} -Action Allow
       New-NetFirewallRule -DisplayName "Bweeep ${args.unit} ${args.port} UDP" -Direction Inbound -Protocol UDP -LocalPort ${args.port} -Action Allow`);
    todo(`공유기 포트포워딩: 외부 TCP ${args.port} → 이 PC 내부 IP 의 ${args.port}`);
  } else {
    info(`포트 ${args.port} 는 방화벽에 이미 열려 있습니다.`);
  }
  if (!realSystemd) info(`--systemd-dir 이 기본값이 아니라 daemon-reload/시작은 하지 않습니다 (${path.dirname(unit.file)}).`);
  if (!unit.exists) {
    todo(`systemctl --user daemon-reload && systemctl --user enable --now ${args.unit}.service`);
  } else if (findings.changes > 0) {
    if (unitChanged && !args.apply) todo("systemctl --user daemon-reload (--apply 가 하지만, 직접 고쳤다면)");
    todo(`설정은 서버를 재시작해야 적용됩니다${status?.activeState === "active" ? " (지금 켜져 있음)" : ""}: systemctl --user restart ${args.unit}.service`);
  }
  todo(`접속 확인: journalctl --user -u ${args.unit}.service -f 에서 "authlib-injector" 와 "Done" 로그를 확인하고, 런처로 접속`);
  if (!args.manifest) todo(`카탈로그: manifest 를 resources/manifests/ 에 두고 node scripts/publish-manifest.mjs <file> → --activate`);
  todo(`빈 서버 재우기: node scripts/gate-server.mjs --dir ${args.dir} --unit ${args.unit} --apply (서버가 한 번 켜진 뒤, 접속자 없을 때)`);
  if (step === 0) info("할 일이 없습니다.");
}

// ---------------------------------------------------------------- small helpers

function pinnedAgentSha256() {
  const source = fs.readFileSync(path.join(REPO, "src", "main", "authlib-injector.ts"), "utf8");
  const match = /sha256:\s*"([a-f0-9]{64})"/.exec(source);
  if (!match) throw new Error("src/main/authlib-injector.ts 에서 authlib-injector sha256 을 찾지 못했습니다.");
  return match[1];
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readProperty(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*=(.*)$`, "m").exec(text);
  return match ? match[1].trim() : null;
}

function writeProperty(text, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, `${key}=${value}`);
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
}

function readXmx(text) {
  const matches = [...text.matchAll(/-Xmx(\d+[kKmMgGtT]?)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)B?$/i.exec(String(value).trim());
  if (!match) throw new Error(`크기 형식이 올바르지 않습니다: ${value} (예: 8G, 6144M)`);
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
  return Math.round(Number(match[1]) * 1024 ** power);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function defaultHeap(memoryMax) {
  const mib = Math.max(1024, Math.floor(parseSize(memoryMax) / 1024 ** 2) - 2048);
  return mib % 1024 === 0 ? `${mib / 1024}G` : `${mib}M`;
}

function halfSize(size) {
  const mib = Math.max(512, Math.floor(parseSize(size) / 1024 ** 2 / 2));
  return mib % 1024 === 0 ? `${mib / 1024}G` : `${mib}M`;
}

function writeAtomic(file, content) {
  const temp = `${file}.open-server-${process.pid}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o644;
  fs.writeFileSync(temp, content, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

function copyAtomic(from, to) {
  const temp = `${to}.open-server-${process.pid}`;
  fs.copyFileSync(from, temp);
  fs.chmodSync(temp, 0o644);
  fs.renameSync(temp, to);
}

function parseArgs(argv) {
  const out = { dir: null, port: null, unit: null, memoryMax: null, java: null, xmx: null, exec: null, owners: null, sqlOut: null,
    manifest: null, apiRoot: DEFAULT_API_ROOT, systemdDir: DEFAULT_SYSTEMD_DIR, backupDir: null, noScan: false, apply: false, help: false };
  const flags = { "--dir": "dir", "--port": "port", "--unit": "unit", "--memory-max": "memoryMax", "--java": "java", "--xmx": "xmx",
    "--exec": "exec", "--owners": "owners", "--sql-out": "sqlOut", "--manifest": "manifest", "--api-root": "apiRoot",
    "--systemd-dir": "systemdDir", "--backup-dir": "backupDir" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--no-scan") out.noScan = true;
    else if (flags[arg]) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && arg !== "--exec")) throw new Error(`${arg} 에 값이 필요합니다.`);
      out[flags[arg]] = next;
      i += 1;
    } else throw new Error(`알 수 없는 인자: ${arg} (--help)`);
  }
  if (out.help) return out;
  if (!out.dir || !out.port || !out.unit) throw new Error("--dir, --port, --unit 은 꼭 필요합니다 (--help).");
  out.port = Number(out.port);
  if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) throw new Error("--port 는 1024-65535 사이 정수여야 합니다.");
  out.unit = out.unit.replace(/\.service$/, "");
  if (!/^[A-Za-z0-9@_.:-]+$/.test(out.unit)) throw new Error("--unit 이름이 올바르지 않습니다.");
  for (const key of ["memoryMax", "xmx"]) if (out[key]) parseSize(out[key]);
  if (!/^https:\/\/\S+$/.test(out.apiRoot)) throw new Error("--api-root 는 https:// 주소여야 합니다.");
  return out;
}

// Runs last so every constant above is initialised.
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`실패: ${error.message}`);
  process.exit(2);
}
if (args.help) {
  console.log(HELP);
} else {
  try {
    await main();
  } catch (error) {
    console.error(`\n실패: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  }
}
