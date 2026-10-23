import path from "node:path";
import { spawn } from "node:child_process";

// The attached broker exits after starting a separate hidden PowerShell helper.
// The helper must survive the launcher's exit before replacing its files.
export const FILE_UPDATE_BROKER_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $helper = [IO.Path]::GetFullPath($request.helper)
  $plan = [IO.Path]::GetFullPath($request.plan)
  if ($helper -match '[\x00-\x1f"]' -or $plan -match '[\x00-\x1f"]') { throw 'Invalid helper path' }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -PlanPath "' + $plan + '"'
  $started = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if ($null -eq $started -or $started.Id -le 0) { throw 'Helper did not start' }
  [Console]::Out.WriteLine('BWEEP_FILE_HELPER_STARTED:' + $started.Id)
} catch {
  [Console]::Error.WriteLine('File helper could not start')
  exit 1
}
`;

export function startFileUpdateHelper(helper: string, plan: string, options: {
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
} = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  if (![helper, plan].every((value) => path.win32.isAbsolute(value) && !/[\x00-\x1f"]/u.test(value)) ||
      !environment.SystemRoot || !path.win32.isAbsolute(environment.SystemRoot)) {
    return Promise.reject(new Error("업데이트 도우미 실행 경로가 잘못되었습니다."));
  }
  const powershell = path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = (options.spawnProcess ?? spawn)(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(FILE_UPDATE_BROKER_COMMAND, "utf16le").toString("base64")], {
    detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (started) resolve();
      else reject(new Error("업데이트 도우미를 실행하지 못했습니다."));
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 30_000);
    child.once("error", () => finish(false));
    child.once("close", () => finish(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4_096) return finish(false);
      if (output.split(/\r?\n/).slice(0, -1).some((line) => /^BWEEP_FILE_HELPER_STARTED:[1-9]\d*$/.test(line))) finish(true);
    });
    child.stdin?.on("error", () => finish(false));
    child.stdin?.end(JSON.stringify({ helper, plan }));
  });
}
