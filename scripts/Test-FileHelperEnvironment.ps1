param([Parameter(Mandatory=$true)][string]$OutputPath,[ValidateRange(10,120)][int]$TimeoutSeconds=45)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'Native Windows PowerShell environment probe required'}
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$probeStart=@'
[Console]::Out.WriteLine('stage=begin|'+[DateTime]::UtcNow.ToString('o')+'|0')
$probeClock=[Diagnostics.Stopwatch]::StartNew()
function Write-ProbeStage([string]$name){[Console]::Out.WriteLine('stage='+$name+'|'+[DateTime]::UtcNow.ToString('o')+'|'+$probeClock.ElapsedMilliseconds)}
Write-ProbeStage 'before-mode-setup'
'@
# -ListImported observes only loaded commands; it does not establish whether a
# command is installed or autoloadable. Exact-name lookup otherwise imports modules.
# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-5.1
$probe=@'
Write-ProbeStage 'after-mode-setup'
[Console]::Out.WriteLine('version='+$PSVersionTable.PSVersion.ToString())
[Console]::Out.WriteLine('edition='+$PSVersionTable.PSEdition)
[Console]::Out.WriteLine('modulePath='+$env:PSModulePath)
[Console]::Out.WriteLine('lookupScope=loaded-session-only-no-autodiscovery')
Write-ProbeStage 'before-command-lookup'
$command=Get-Command Get-FileHash -ListImported -ErrorAction SilentlyContinue
[Console]::Out.WriteLine('loadedGetFileHash='+[bool]$command)
[Console]::Out.WriteLine('loadedCommandModule='+$command.ModuleName)
[Console]::Out.WriteLine('loadedCommandPath='+$command.Module.Path)
[Console]::Out.WriteLine('loadedConvertFromJson='+[bool](Get-Command ConvertFrom-Json -ListImported -ErrorAction SilentlyContinue))
[Console]::Out.WriteLine('loadedConvertToJson='+[bool](Get-Command ConvertTo-Json -ListImported -ErrorAction SilentlyContinue))
Write-ProbeStage 'after-command-lookup'
'@
$results=@()
function Save-ProbeResults([string]$phase,[string]$errorText=''){
  @{schema=1;phase=$phase;error=$errorText;hostVersion=$PSVersionTable.PSVersion.ToString();hostEdition=$PSVersionTable.PSEdition;hostModulePath=$env:PSModulePath;timeoutSeconds=$TimeoutSeconds;results=$results;lookupScope='Loaded session commands only; absence does not mean uninstalled or unavailable for autoload';scope='Read-only native child PowerShell probes; only child environment changes, no app or login launch'}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
Save-ProbeResults 'running'
foreach($mode in @('inherited','default-module-path','autoload-disabled','native-cmdlets-no-autoload')){
  $modeSetup=''
  if($mode -eq 'autoload-disabled'){$modeSetup='$PSModuleAutoLoadingPreference=''None'';'}
  if($mode -eq 'native-cmdlets-no-autoload'){
    $modeSetup=@'
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Utility,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Management,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
$PSModuleAutoLoadingPreference='None';
'@
  }
  $script=$probeStart+[Environment]::NewLine+$modeSetup+[Environment]::NewLine+$probe
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$powershell
  $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  if($mode -eq 'default-module-path'){$start.EnvironmentVariables.Remove('PSModulePath')}
  if($mode -in @('autoload-disabled','native-cmdlets-no-autoload')){$start.EnvironmentVariables['PSModulePath']=''}
  $clock=[Diagnostics.Stopwatch]::StartNew();$child=$null
  $entry=@{mode=$mode;startedUtc=[DateTime]::UtcNow.ToString('o');timeoutSeconds=$TimeoutSeconds;elapsedMs=0;timedOut=$false;exitCode=$null;stdout='';stderr='';stdoutComplete=$false;stderrComplete=$false;stages=@()}
  $failure=$null
  try{
    $child=[Diagnostics.Process]::Start($start)
    $stdoutRead=$child.StandardOutput.ReadToEndAsync();$stderrRead=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit($TimeoutSeconds*1000)){
      $entry.timedOut=$true
      $child.Kill()
      [void]$child.WaitForExit(5000)
      $failure="Owned module environment probe '$mode' did not exit within $TimeoutSeconds seconds"
    }
    $entry.stdoutComplete=$stdoutRead.Wait(1000);$entry.stderrComplete=$stderrRead.Wait(1000)
    if($entry.stdoutComplete){$entry.stdout=$stdoutRead.Result.Substring(0,[Math]::Min(8192,$stdoutRead.Result.Length))}
    if($entry.stderrComplete){$entry.stderr=$stderrRead.Result.Substring(0,[Math]::Min(8192,$stderrRead.Result.Length))}
    if($child.HasExited){$entry.exitCode=$child.ExitCode}
    $entry.stderrPresent=[bool]$entry.stderr
    foreach($line in @($entry.stdout -split '\r?\n')){
      if($line -match '^(version|edition|modulePath|lookupScope|loadedGetFileHash|loadedCommandModule|loadedCommandPath|loadedConvertFromJson|loadedConvertToJson)=(.*)$'){$entry[$Matches[1]]=$Matches[2]}
      if($line -match '^stage=([a-z-]+)\|([^|]+)\|(\d+)$'){
        $entry.stages+=@{name=$Matches[1];utc=$Matches[2];elapsedMs=[long]$Matches[3]}
        if($Matches[1] -eq 'begin'){$entry.startupElapsedMs=([DateTime]::Parse($Matches[2])-[DateTime]::Parse($entry.startedUtc)).TotalMilliseconds}
      }
    }
    if(-not $failure -and $entry.exitCode -ne 0){$failure="Owned module environment probe '$mode' failed with exit code $($entry.exitCode)"}
  }catch{
    $failure=$_.Exception.Message
  }finally{
    $clock.Stop();$entry.elapsedMs=$clock.ElapsedMilliseconds
    if($failure){$entry.error=$failure.Substring(0,[Math]::Min(1024,$failure.Length))}
    $results+=@($entry)
    Save-ProbeResults $(if($failure){'failed'}else{'running'}) $(if($failure){$entry.error}else{''})
    if($child){$child.Dispose()}
  }
  if($failure){throw $failure}
}
Save-ProbeResults 'passed'
Write-Output $OutputPath
