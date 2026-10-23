param([string]$HelperPath='E:\Projects\bweeep-launcher-supabase-updates\build\file-update-helper.ps1')
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition -eq 'Core'){
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -HelperPath $HelperPath
  if($LASTEXITCODE -ne 0){throw "Windows PowerShell helper fixture failed: $LASTEXITCODE"}
  return
}
$base=Join-Path $PSScriptRoot ('helper-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $base | Out-Null
$helper=(Resolve-Path -LiteralPath $HelperPath).Path
$probe=Join-Path $base 'probe.exe'
Add-Type -OutputAssembly $probe -OutputType WindowsApplication -TypeDefinition @'
using System;using System.IO;using System.Reflection;
public static class Probe{[STAThread]public static void Main(){File.AppendAllText(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),"restarted.txt"),"restart\n");}}
'@
$results=New-Object System.Collections.ArrayList
function Check([bool]$ok,[string]$message){if(-not $ok){throw $message}}
function New-Case([string]$name){
  $dir=Join-Path $base $name;$r=Join-Path $dir 'installed';$s=Join-Path $dir 'stage'
  New-Item -ItemType Directory -Path (Join-Path $r 'data'),(Join-Path $s 'data') -Force|Out-Null
  Copy-Item -LiteralPath $probe -Destination (Join-Path $r 'Bweeep.exe')
  [IO.File]::WriteAllText((Join-Path $r 'data\value'),'old');[IO.File]::WriteAllText((Join-Path $s 'data\value'),'new')
  return @{dir=$dir;root=$r;stage=$s;id=[guid]::NewGuid().ToString()}
}
function Item([hashtable]$c,[string]$p){return @{path=$p;sha256=(Get-FileHash -LiteralPath (Join-Path $c.stage $p) -Algorithm SHA256).Hash.ToLowerInvariant()}}
function Run([hashtable]$c,[object[]]$items,[object[]]$removed=@(),[int]$parent=2147483647){
  $plan=Join-Path $c.dir 'plan.json';@{id=$c.id;root=$c.root;staged=$c.stage;parentPid=$parent;changed=$items;removed=$removed}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $plan -Encoding UTF8
  $clock=[Diagnostics.Stopwatch]::StartNew();$errorText=$null
  try{& $helper -PlanPath $plan}catch{$errorText=$_.Exception.Message}
  $clock.Stop();$until=[DateTime]::UtcNow.AddSeconds(3)
  while(-not(Test-Path -LiteralPath (Join-Path $c.root 'restarted.txt')) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 100}
  return @{error=$errorText;elapsedMs=$clock.ElapsedMilliseconds;restart=(Test-Path -LiteralPath (Join-Path $c.root 'restarted.txt'))}
}
$c=New-Case 'apply';[IO.File]::WriteAllText((Join-Path $c.root 'data\obsolete'),'old');[IO.File]::WriteAllText((Join-Path $c.stage 'data\added'),'added')
$r=Run $c @((Item $c 'data/value'),(Item $c 'data/added')) @('data/obsolete')
Check ($null -eq $r.error -and $r.restart) 'Apply/restart failed'
Check ([IO.File]::ReadAllText((Join-Path $c.root 'data\value')) -eq 'new') 'Replacement missing'
Check (-not(Test-Path -LiteralPath (Join-Path $c.root 'data\obsolete'))) 'Removal missing'
Check ([IO.File]::ReadAllText((Join-Path $c.root ('.bweeep-update-backup-'+$c.id+'\data\value'))) -eq 'old') 'Backup missing'
[void]$results.Add(@{case='apply-add-remove-backup-restart';passed=$true;detail=$r})
$c=New-Case 'tamper';$r=Run $c @(@{path='data/value';sha256=('0'*64)})
Check ($r.error -match 'hash mismatch') 'Tamper accepted';Check ([IO.File]::ReadAllText((Join-Path $c.root 'data\value')) -eq 'old') 'Tamper changed bytes'
[void]$results.Add(@{case='tamper';passed=$true;detail=$r})
$c=New-Case 'rollback';[IO.File]::WriteAllText((Join-Path $c.root 'blocked'),'not a directory');New-Item -ItemType Directory -Path (Join-Path $c.stage 'blocked')|Out-Null;[IO.File]::WriteAllText((Join-Path $c.stage 'blocked\next'),'next')
$r=Run $c @((Item $c 'data/value'),(Item $c 'blocked/next'))
Check ($null -ne $r.error -and $r.restart) 'Induced failure/restart absent';Check ([IO.File]::ReadAllText((Join-Path $c.root 'data\value')) -eq 'old') 'Partial update was not rolled back'
[void]$results.Add(@{case='rollback';passed=$true;detail=$r})
$c=New-Case 'parent-wait';$p=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 2' -WindowStyle Hidden -PassThru
$r=Run $c @((Item $c 'data/value')) @() $p.Id
Check ($null -eq $r.error -and $r.elapsedMs -ge 1400 -and $r.restart) 'Parent wait/restart failed'
[void]$results.Add(@{case='parent-wait';passed=$true;detail=$r})
@{helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();results=$results;coverage='Exact production helper with owned executable fixtures only; no real app/NSIS/game/ACL changes.'}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $base 'result.json') -Encoding UTF8
Write-Output (Join-Path $base 'result.json')
