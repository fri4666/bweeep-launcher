param([Parameter(Mandatory=$true)][string]$OutputPath)
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
  $child=[Diagnostics.Process]::Start($start)
  $stdoutRead=$child.StandardOutput.ReadToEndAsync();$stderrRead=$child.StandardError.ReadToEndAsync()
  if(-not $child.WaitForExit(10000)){$child.Kill();$child.Dispose();throw 'Owned module environment probe did not exit'}
  $stdout=$stdoutRead.Result;$stderr=$stderrRead.Result
  $entry=@{mode=$mode;exitCode=$child.ExitCode;stderrPresent=([bool]$stderr)}
  foreach($line in @($stdout -split '\r?\n')){
    if($line -match '^(version|edition|modulePath|getFileHash|commandModule|commandPath|convertFromJson|convertToJson)=(.*)$'){$entry[$Matches[1]]=$Matches[2]}
  }
  $results+=@($entry)
  $child.Dispose()
}
@{schema=1;hostVersion=$PSVersionTable.PSVersion.ToString();hostEdition=$PSVersionTable.PSEdition;hostModulePath=$env:PSModulePath;results=$results;scope='Read-only native child PowerShell probes; only child environment changes, no app or login launch'}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output $OutputPath
