param([string]$HelperPath='E:\Projects\bweeep-launcher-supabase-updates\build\file-update-helper.ps1',[switch]$WithoutFileHashCmdlet)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition -eq 'Core'){
  $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-HelperPath',$HelperPath)
  if($WithoutFileHashCmdlet){$arguments+='-WithoutFileHashCmdlet'}
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
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
  $hashCmdletUnavailable=$false
  if($WithoutFileHashCmdlet){
    $resultFile=Join-Path $c.dir 'restricted-helper-result.json'
    $command=@'
$ErrorActionPreference='Stop'
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Utility,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Management,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
$PSModuleAutoLoadingPreference='None'
if(Get-Command Get-FileHash -ErrorAction SilentlyContinue){throw 'Fixture requires the actual hash function to be unavailable'}
foreach($name in @('Get-Content','ConvertFrom-Json','ConvertTo-Json','New-Item','Copy-Item','Start-Process')){if(-not(Get-Command $name -ErrorAction SilentlyContinue)){throw ('Required native cmdlet absent: '+$name)}}
$result=@{hashCmdletUnavailable=$true;error=$null}
try{& '__HELPER__' -PlanPath '__PLAN__'}catch{$result.error=$_.Exception.Message}
[IO.File]::WriteAllText('__RESULT__',($result|ConvertTo-Json -Compress))
'@
    $command=$command.Replace('__HELPER__',$helper.Replace("'","''")).Replace('__PLAN__',$plan.Replace("'","''")).Replace('__RESULT__',$resultFile.Replace("'","''"))
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.EnvironmentVariables['PSModulePath']=''
    $child=[Diagnostics.Process]::Start($start)
    $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit(45000)){
      $child.Kill();[void]$child.WaitForExit(5000)
      $stdoutComplete=$stdout.Wait(1000);$stderrComplete=$stderr.Wait(1000)
      $diagnostic=@{case=(Split-Path -Leaf $c.dir);timeoutSeconds=45;elapsedMs=$clock.ElapsedMilliseconds;timedOut=$true;stdout='';stderr='';stdoutComplete=$stdoutComplete;stderrComplete=$stderrComplete}
      if($stdoutComplete){$diagnostic.stdout=$stdout.Result.Substring(0,[Math]::Min(8192,$stdout.Result.Length))}
      if($stderrComplete){$diagnostic.stderr=$stderr.Result.Substring(0,[Math]::Min(8192,$stderr.Result.Length))}
      @{phase='failed';withoutFileHashCmdlet=$true;results=@($results);failedProbe=$diagnostic}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $base 'result.json') -Encoding UTF8
      $child.Dispose()
      throw 'Owned restricted helper fixture did not exit within 45 seconds'
    }
    if($child.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $resultFile)){throw ('Restricted helper fixture setup failed: '+$stderr.Result)}
    $restricted=Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8|ConvertFrom-Json
    $errorText=$restricted.error;$hashCmdletUnavailable=$restricted.hashCmdletUnavailable
    $child.Dispose()
  }else{try{& $helper -PlanPath $plan}catch{$errorText=$_.Exception.Message}}
  $clock.Stop();$until=[DateTime]::UtcNow.AddSeconds(3)
  while(-not(Test-Path -LiteralPath (Join-Path $c.root 'restarted.txt')) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 100}
  return @{error=$errorText;elapsedMs=$clock.ElapsedMilliseconds;restart=(Test-Path -LiteralPath (Join-Path $c.root 'restarted.txt'));hashCmdletUnavailable=$hashCmdletUnavailable}
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
Check ((Get-Content -LiteralPath (Join-Path $c.stage 'apply-error.json') -Raw|ConvertFrom-Json).message -match 'hash mismatch') 'Original hash failure was not logged'
[void]$results.Add(@{case='tamper';passed=$true;detail=$r})
$c=New-Case 'rollback';[IO.File]::WriteAllText((Join-Path $c.root 'blocked'),'not a directory');New-Item -ItemType Directory -Path (Join-Path $c.stage 'blocked')|Out-Null;[IO.File]::WriteAllText((Join-Path $c.stage 'blocked\next'),'next')
$r=Run $c @((Item $c 'data/value'),(Item $c 'blocked/next'))
Check ($null -ne $r.error -and $r.restart) 'Induced failure/restart absent';Check ([IO.File]::ReadAllText((Join-Path $c.root 'data\value')) -eq 'old') 'Partial update was not rolled back'
Check (Test-Path -LiteralPath (Join-Path $c.stage 'apply-error.json')) 'Original rollback-triggering failure was not logged'
[void]$results.Add(@{case='rollback';passed=$true;detail=$r})
$c=New-Case 'parent-wait';$p=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 2' -WindowStyle Hidden -PassThru
$r=Run $c @((Item $c 'data/value')) @() $p.Id
Check ($null -eq $r.error -and $r.elapsedMs -ge 1400 -and $r.restart) 'Parent wait/restart failed'
[void]$results.Add(@{case='parent-wait';passed=$true;detail=$r})
@{helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();withoutFileHashCmdlet=[bool]$WithoutFileHashCmdlet;results=$results;coverage='Exact production helper with owned executable fixtures; restricted mode loads native Windows cmdlet assemblies but no hash function, disables autoload and clears only the child module path. No real app/NSIS/game/ACL changes.'}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $base 'result.json') -Encoding UTF8
Write-Output (Join-Path $base 'result.json')
