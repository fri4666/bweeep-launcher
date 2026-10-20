#!/usr/bin/env node
// Checks a modpack manifest with the same rules as the launcher and the
// launcher-access Edge Function, then prints (or, with --apply, runs) the SQL
// that adds it to the launcher_releases catalog. Publishing is two steps:
// the release is inserted inactive, and a second run makes it the one active
// release of its pack. See --help.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertManifest } from "../src/main/manifest-validation.ts";
import { isModpackManifest, parseStorageObjectUrl } from "../supabase/functions/launcher-access/manifest-shape.ts";

const DEFAULT_PROJECT = "tmwvrglzjfzauuygofpp";
const PACK_ID = /^[a-z0-9][a-z0-9-]{1,62}$/; // launcher_releases_pack_id_check
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `사용법: node scripts/publish-manifest.mjs [manifest.json] [옵션]

모드팩 manifest를 런처·Edge Function과 같은 규칙으로 검사하고, 카탈로그
(public.launcher_releases)에 올리는 SQL을 만듭니다. 기본은 dry-run: SQL만
출력하고 아무 데도 쓰지 않습니다.

배포 순서
  1) 추가(비활성):  node scripts/publish-manifest.mjs resources/manifests/<팩>.json
  2) 활성화:        node scripts/publish-manifest.mjs resources/manifests/<팩>.json --activate
     같은 팩의 기존 활성 release를 끄고 이 release를 켭니다(한 트랜잭션).
  되돌리기:         node scripts/publish-manifest.mjs --activate --pack <팩> --version <이전 버전>
  실제 적용은 각 단계에 --apply를 붙입니다.

옵션
  --activate            추가 대신 활성화 SQL을 만듭니다.
  --pack <id> --version <v>
                        manifest 파일 없이 이미 있는 release를 활성화할 때(되돌리기).
  --check               검사만 하고 SQL은 출력하지 않습니다. 파일을 여러 개 줄 수 있습니다.
  --verify-downloads    https 파일을 실제로 받아 크기와 해시를 확인합니다(storage:// 는 건너뜀).
  --created-by <uuid>   release 작성자. 없으면 가장 먼저 초대된 관리자(admin).
  --out <file>          SQL을 파일로 씁니다.
  --apply               Supabase Management API로 SQL을 실행합니다.
                        토큰: SUPABASE_ACCESS_TOKEN 또는 ~/.supabase/access-token
  --project <ref>       --apply 대상 프로젝트 (기본 ${DEFAULT_PROJECT})
  --api <url>           Management API 주소 (기본 https://api.supabase.com, 시험용)
  -h, --help            이 도움말

규칙 (런처 assertManifest + Edge Function isModpackManifest + 배포 정책)
  - gameAuth 는 반드시 "yggdrasil" (offline 서버는 올리지 않음)
  - 모든 파일에 sha256 또는 sha512, 주소는 https:// 또는 storage://<bucket>/<path>
  - server.host 는 도메인/IPv4(localhost 불가), server.port 는 1-65535
  - id 는 소문자·숫자·하이픈, version 은 공백 없는 64자 이하
  - 활성화 SQL은 DB에 저장된 manifest도 yggdrasil인지 다시 확인합니다.`;

const log = (line = "") => console.error(line);
let args;

// Imported by scripts/open-server.mjs for validateForPublish; only runs as a command.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
    } else {
      await main();
    }
  } catch (error) {
    log(`실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function main() {
  if (args.check) {
    if (!args.files.length) throw new Error("--check 에는 manifest 파일이 필요합니다.");
    let failed = 0;
    for (const file of args.files) {
      try {
        const manifest = readManifest(file);
        const warnings = validateForPublish(manifest);
        if (args.verifyDownloads) await verifyDownloads(manifest);
        log(`통과 ${file} (${manifest.id} ${manifest.version})${warnings.map((w) => `\n  경고: ${w}`).join("")}`);
      } catch (error) {
        failed += 1;
        log(`거부 ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  if (args.files.length > 1) throw new Error("manifest 파일은 하나만 줄 수 있습니다(--check 제외).");
  const file = args.files[0];
  let manifest = null;
  if (file) {
    manifest = readManifest(file);
    for (const warning of validateForPublish(manifest)) log(`경고: ${warning}`);
    if (args.verifyDownloads) await verifyDownloads(manifest);
    if (args.pack && args.pack !== manifest.id) throw new Error(`--pack ${args.pack} 이 manifest id ${manifest.id} 와 다릅니다.`);
    if (args.version && args.version !== manifest.version) throw new Error(`--version ${args.version} 이 manifest version ${manifest.version} 과 다릅니다.`);
    log(`검사 통과: ${manifest.id} ${manifest.version} (${manifest.loader.kind} ${manifest.minecraftVersion}, ${manifest.server.host}:${manifest.server.port}, 파일 ${manifest.files.length}개)`);
  } else if (!args.activate) {
    throw new Error("manifest 파일이 필요합니다. 도움말: --help");
  }

  const packId = manifest?.id ?? args.pack;
  const version = manifest?.version ?? args.version;
  if (!packId || !version) throw new Error("--activate 에는 manifest 파일 또는 --pack 과 --version 이 필요합니다.");
  if (!PACK_ID.test(packId) || !VERSION.test(version)) throw new Error("pack id 또는 version 형식이 올바르지 않습니다.");
  if (args.createdBy && !UUID.test(args.createdBy)) throw new Error("--created-by 는 UUID여야 합니다.");

  const sql = args.activate ? activateSql(packId, version, manifest) : insertSql(manifest, args.createdBy);

  if (!args.apply) {
    if (args.out) {
      fs.writeFileSync(args.out, `${sql}\n`);
      log(`SQL을 ${args.out} 에 썼습니다. (dry-run: DB는 바뀌지 않음)`);
    } else {
      console.log(sql);
      log("(dry-run: DB는 바뀌지 않았습니다. 실행하려면 --apply)");
    }
    if (!args.activate) log(`다음 단계(활성화): node scripts/publish-manifest.mjs ${file} --activate`);
    return;
  }

  const api = managementApi(args.project, args.api);
  log(`대상 프로젝트: ${args.project} (${args.api})`);
  const before = await api.query(releasesQuery(packId));
  log(`현재 ${packId} release: ${before.map((row) => `${row.version}${row.active ? "(활성)" : ""}`).join(", ") || "없음"}`);
  const previousActive = before.find((row) => row.active)?.version ?? null;
  await api.query(sql);
  const after = await api.query(releasesQuery(packId));
  const row = after.find((candidate) => candidate.version === version);
  if (!row) throw new Error("적용 후 release를 찾지 못했습니다.");
  if (manifest && !row.same_manifest) throw new Error("저장된 manifest가 파일과 다릅니다.");
  if (args.activate) {
    const active = after.filter((candidate) => candidate.active);
    if (active.length !== 1 || active[0].version !== version) throw new Error(`활성 release 확인 실패: ${active.map((r) => r.version).join(", ")}`);
    log(`활성화 완료: ${packId} ${version}`);
    if (previousActive && previousActive !== version) {
      log(`되돌리기: node scripts/publish-manifest.mjs --activate --pack ${packId} --version ${previousActive} --apply`);
    }
  } else {
    log(`추가 완료: ${packId} ${version} (${row.active ? "이미 활성 상태" : "비활성"})`);
    log(`다음 단계(활성화): node scripts/publish-manifest.mjs ${file} --activate --apply`);
  }

  function releasesQuery(pack) {
    const same = manifest ? `manifest = ${sqlString(JSON.stringify(manifest))}::jsonb` : "null::boolean";
    return `select version, active, ${same} as same_manifest from public.launcher_releases where pack_id = ${sqlString(pack)} order by created_at;`;
  }
}

/** Every rule a release must pass. Throws on the first hard failure, returns warnings. */
export function validateForPublish(manifest) {
  // The launcher refuses anything assertManifest refuses …
  assertManifest(manifest);
  // … and launcher-access refuses to serve anything isModpackManifest refuses.
  if (!isModpackManifest(manifest)) throw new Error("Edge Function(launcher-access)의 manifest 형식 검사에 걸렸습니다.");

  if (manifest.gameAuth !== "yggdrasil") {
    throw new Error(`gameAuth 가 "${manifest.gameAuth ?? "offline(기본값)"}" 입니다. 이제 모든 서버는 "yggdrasil" 이어야 합니다.`);
  }
  if (!PACK_ID.test(manifest.id)) throw new Error(`id "${manifest.id}" 는 소문자·숫자·하이픈 2-63자여야 합니다.`);
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw new Error(`version "${manifest.version}" 형식이 올바르지 않습니다.`);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("name 이 비어 있습니다.");
  if (manifest.audience !== undefined && manifest.audience !== "members" && manifest.audience !== "testers") {
    throw new Error(`audience "${manifest.audience}" 는 members 또는 testers 여야 합니다.`);
  }
  if (manifest.default !== undefined && typeof manifest.default !== "boolean") throw new Error("default 는 true/false 여야 합니다.");

  const { host, port } = manifest.server ?? {};
  if (typeof host !== "string" || !HOSTNAME.test(host) || /^(localhost|127\.|0\.0\.0\.0)/i.test(host)) {
    throw new Error(`server.host "${host}" 는 외부에서 접속할 수 있는 도메인이나 IPv4여야 합니다.`);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`server.port "${port}" 가 올바르지 않습니다.`);

  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.path.toLowerCase())) throw new Error(`파일 경로가 중복됩니다: ${file.path}`);
    seen.add(file.path.toLowerCase());
    if (file.url.startsWith("storage://")) {
      parseStorageObjectUrl(file.url);
      continue;
    }
    let url;
    try {
      url = new URL(file.url);
    } catch {
      throw new Error(`${file.path} 의 주소가 URL이 아닙니다: ${file.url}`);
    }
    if (url.protocol !== "https:") throw new Error(`${file.path} 의 주소는 https:// 또는 storage:// 여야 합니다: ${file.url}`);
  }

  const warnings = [];
  if (!manifest.clientFeatures?.connectionLock) warnings.push("clientFeatures.connectionLock 이 없어 다른 서버 접속을 막지 않습니다.");
  if (manifest.files.some((file) => /(^|\/)bweeep-server-auth[^/]*\.jar$/i.test(file.path))) {
    warnings.push("예전 로그인 모드(bweeep-server-auth)가 들어 있습니다. yggdrasil 서버에는 필요 없습니다.");
  }
  return warnings;
}

function readManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} 을(를) JSON으로 읽지 못했습니다: ${error instanceof Error ? error.message : error}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${file} 은(는) JSON 객체가 아닙니다.`);
  return manifest;
}

async function verifyDownloads(manifest) {
  const skipped = manifest.files.filter((file) => file.url.startsWith("storage://")).length;
  const targets = manifest.files
    .filter((file) => !file.url.startsWith("storage://"))
    .map((file) => ({ label: file.path, url: file.url, size: file.size, sha256: file.sha256, sha512: file.sha512 }));
  if (manifest.mrpack) targets.push({ label: "mrpack", ...manifest.mrpack });
  for (const target of targets) {
    const response = await fetch(target.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`${target.label} 받기 실패: HTTP ${response.status}`);
    const algorithm = target.sha256 ? "sha256" : "sha512";
    const hash = crypto.createHash(algorithm);
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
    const digest = hash.digest("hex");
    if (size !== target.size) throw new Error(`${target.label} 크기가 다릅니다: manifest ${target.size}, 실제 ${size}`);
    if (digest !== String(target[algorithm]).toLowerCase()) throw new Error(`${target.label} ${algorithm} 가 다릅니다.`);
  }
  log(`다운로드 확인: ${targets.length}개 일치${skipped ? `, storage:// ${skipped}개는 건너뜀` : ""}`);
}

function insertSql(manifest, createdBy) {
  const json = JSON.stringify(manifest);
  const author = createdBy
    ? sqlString(createdBy)
    : "(select user_id from public.launcher_members where role = 'admin' order by invited_at limit 1)";
  return [
    `-- ${manifest.id} ${manifest.version}: 비활성 release로 추가 (${new Date().toISOString()})`,
    "begin;",
    "insert into public.launcher_releases (pack_id, version, manifest, active, created_by)",
    `values (${sqlString(manifest.id)}, ${sqlString(manifest.version)}, ${sqlString(json)}::jsonb, false, ${author})`,
    "on conflict (pack_id, version) do nothing;",
    // Releases are append-only: a second run is a no-op, but a different
    // manifest under an existing version is refused instead of ignored.
    guard(
      `not exists (select 1 from public.launcher_releases where pack_id = ${sqlString(manifest.id)} and version = ${sqlString(manifest.version)} and manifest = ${sqlString(json)}::jsonb)`,
      `${manifest.id} ${manifest.version} 는 이미 다른 manifest로 등록되어 있습니다. version을 올리세요.`
    ),
    "commit;"
  ].join("\n");
}

function activateSql(packId, version, manifest) {
  const target = `pack_id = ${sqlString(packId)} and version = ${sqlString(version)}`;
  const lines = [
    `-- ${packId} ${version}: 활성화 (같은 팩의 다른 release는 비활성)`,
    "begin;",
    guard(`not exists (select 1 from public.launcher_releases where ${target})`, `${packId} ${version} release가 없습니다. 먼저 추가하세요.`),
    guard(
      `exists (select 1 from public.launcher_releases where ${target} and manifest->>'gameAuth' is distinct from 'yggdrasil')`,
      `${packId} ${version} 는 yggdrasil release가 아니라 활성화할 수 없습니다.`
    )
  ];
  if (manifest) {
    lines.push(guard(
      `not exists (select 1 from public.launcher_releases where ${target} and manifest = ${sqlString(JSON.stringify(manifest))}::jsonb)`,
      `저장된 ${packId} ${version} manifest가 이 파일과 다릅니다.`
    ));
  }
  lines.push(
    `update public.launcher_releases set active = false where pack_id = ${sqlString(packId)} and active and version <> ${sqlString(version)};`,
    `update public.launcher_releases set active = true where ${target} and not active;`,
    "commit;"
  );
  return lines.join("\n");
}

/** A DO block that aborts the transaction when `condition` holds. */
function guard(condition, message) {
  const body = `begin if ${condition} then raise exception '%', ${sqlString(message)}; end if; end`;
  if (body.includes("$publish$")) throw new Error("manifest에 $publish$ 문자열이 들어 있어 SQL로 만들 수 없습니다.");
  return `do $publish$ ${body} $publish$;`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function managementApi(project, base) {
  if (!/^[a-z0-9]{20}$/.test(project)) throw new Error(`프로젝트 ref 형식이 이상합니다: ${project}`);
  const tokenFile = path.join(os.homedir(), ".supabase", "access-token");
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim() || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
  if (!token) throw new Error(`Supabase 토큰이 없습니다 (SUPABASE_ACCESS_TOKEN 또는 ${tokenFile}).`);
  return {
    async query(query) {
      const response = await fetch(`${base.replace(/\/+$/, "")}/v1/projects/${project}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Management API ${response.status}: ${text.slice(0, 500)}`);
      const rows = text ? JSON.parse(text) : [];
      return Array.isArray(rows) ? rows : [];
    }
  };
}

function parseArgs(argv) {
  const out = { files: [], activate: false, apply: false, check: false, verifyDownloads: false, help: false,
    project: DEFAULT_PROJECT, api: "https://api.supabase.com", pack: null, version: null, createdBy: null, out: null };
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} 에 값이 필요합니다.`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h": case "--help": out.help = true; break;
      case "--activate": out.activate = true; break;
      case "--apply": out.apply = true; break;
      case "--check": out.check = true; break;
      case "--verify-downloads": out.verifyDownloads = true; break;
      case "--pack": out.pack = value(arg, i); i += 1; break;
      case "--version": out.version = value(arg, i); i += 1; break;
      case "--created-by": out.createdBy = value(arg, i); i += 1; break;
      case "--out": out.out = value(arg, i); i += 1; break;
      case "--project": out.project = value(arg, i); i += 1; break;
      case "--api": out.api = value(arg, i); i += 1; break;
      default:
        if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션: ${arg} (--help)`);
        out.files.push(arg);
    }
  }
  if (out.check && (out.apply || out.activate)) throw new Error("--check 는 --apply/--activate 와 같이 쓸 수 없습니다.");
  return out;
}
