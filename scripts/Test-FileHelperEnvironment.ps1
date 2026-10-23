param([Parameter(Mandatory=$true)][string]$OutputPath,[ValidateRange(10,120)][int]$TimeoutSeconds=45)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'Native Windows PowerShell environment probe required'}
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$probe=@'
$command=Get-Command Get-FileHash -ErrorAction SilentlyContinue
[Console]::Out.WriteLine('version='+$PSVersionTable.PSVersion.ToString())
[Console]::Out.WriteLine('edition='+$PSVersionTable.PSEdition)
[Console]::Out.WriteLine('modulePath='+$env:PSModulePath)
[Console]::Out.WriteLine('getFileHash='+[bool]$command)
[Console]::Out.WriteLine('commandModule='+$command.ModuleName)
[Console]::Out.WriteLine('commandPath='+$command.Module.Path)
[Console]::Out.WriteLine('convertFromJson='+[bool](Get-Command ConvertFrom-Json -ErrorAction SilentlyContinue))
[Console]::Out.WriteLine('convertToJson='+[bool](Get-Command ConvertTo-Json -ErrorAction SilentlyContinue))
'@
$results=@()
function Save-ProbeResults([string]$phase,[string]$errorText=''){
  @{schema=1;phase=$phase;error=$errorText;hostVersion=$PSVersionTable.PSVersion.ToString();hostEdition=$PSVersionTable.PSEdition;hostModulePath=$env:PSModulePath;timeoutSeconds=$TimeoutSeconds;results=$results;scope='Read-only native child PowerShell probes; only child environment changes, no app or login launch'}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
Save-ProbeResults 'running'
foreach($mode in @('inherited','default-module-path','autoload-disabled','native-cmdlets-no-autoload')){
  $script=$probe
  if($mode -eq 'autoload-disabled'){$script='$PSModuleAutoLoadingPreference=''None'';'+$probe}
  if($mode -eq 'native-cmdlets-no-autoload'){
    $script=@'
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Utility,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
Import-Module -Assembly ([Reflection.Assembly]::Load('Microsoft.PowerShell.Commands.Management,Version=3.0.0.0,Culture=neutral,PublicKeyToken=31bf3856ad364e35'))
$PSModuleAutoLoadingPreference='None';
'@+$probe
  }
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$powershell
  $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  if($mode -eq 'default-module-path'){$start.EnvironmentVariables.Remove('PSModulePath')}
  if($mode -in @('autoload-disabled','native-cmdlets-no-autoload')){$start.EnvironmentVariables['PSModulePath']=''}
  $clock=[Diagnostics.Stopwatch]::StartNew();$child=$null
  $entry=@{mode=$mode;startedUtc=[DateTime]::UtcNow.ToString('o');timeoutSeconds=$TimeoutSeconds;elapsedMs=0;timedOut=$false;exitCode=$null;stdout='';stderr='';stdoutComplete=$false;stderrComplete=$false}
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
      if($line -match '^(version|edition|modulePath|getFileHash|commandModule|commandPath|convertFromJson|convertToJson)=(.*)$'){$entry[$Matches[1]]=$Matches[2]}
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
