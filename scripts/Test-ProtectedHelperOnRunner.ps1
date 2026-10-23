param([string]$HelperPath=(Join-Path $PSScriptRoot '..\build\file-update-helper.ps1'))
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Disposable Windows runner only; never run on the normal PC'}
$id=[guid]::NewGuid().ToString()
$work=Join-Path $env:RUNNER_TEMP 'bweeep-protected-helper-proof'
New-Item -ItemType Directory -Path $work -Force|Out-Null
$report=Join-Path $work 'protected-receipt.json'
$task='Bweeep-Release-Probe-'+$id
$root=Join-Path $env:ProgramFiles ('BweeepReleaseValidation-'+$id)
$stage=Join-Path $work 'stage'
$helper=(Resolve-Path -LiteralPath $HelperPath).Path
try{
  New-Item -ItemType Directory -Path (Join-Path $root 'data'),(Join-Path $stage 'data') -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\where.exe') -Destination (Join-Path $root 'Bweeep.exe')
  [IO.File]::WriteAllText((Join-Path $root 'data\value.txt'),'old')
  [IO.File]::WriteAllText((Join-Path $stage 'data\value.txt'),'new')
  $plan=Join-Path $work 'plan.json'
  @{id=$id;root=$root;staged=$stage;parentPid=2147483647;changed=@(@{path='data/value.txt';sha256=(Get-FileHash -LiteralPath (Join-Path $stage 'data\value.txt') -Algorithm SHA256).Hash.ToLowerInvariant()});removed=@()}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $plan -Encoding UTF8
  @{fixture=$root;sddl=(Get-Acl -LiteralPath $root).Sddl;rule='Default inherited Program Files permissions; no ACL modification'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'fixture-acl.json') -Encoding UTF8
  $wrapper=Join-Path $PSScriptRoot 'Invoke-LimitedHelper.ps1'
  $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$wrapper+'" -HelperPath "'+$helper+'" -PlanPath "'+$plan+'" -ReceiptPath "'+$report+'"'
  $action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force|Out-Null
  Start-ScheduledTask -TaskName $task
  $deadline=[DateTime]::UtcNow.AddSeconds(40)
  while(-not(Test-Path -LiteralPath $report) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 250}
  if(-not(Test-Path -LiteralPath $report)){throw 'Limited-token task did not produce evidence; interactive task may be unavailable'}
  $observed=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json
  if($observed.phase -ne 'protected-write-denial-reproduced' -or $observed.elevated -ne $false -or $observed.writeDenied -ne $true){throw 'Protected Medium-token denial not established; this is not a protected-update pass'}
  Get-Content -LiteralPath $report
}catch{
  @{phase='not-covered';reason=$_.Exception.Message;fixture=$root;protectedUpdateVerified=$false;coverageKind='observational-only';aclModified=$false;rule='No retry with alternate authority or ACL changes'}|ConvertTo-Json|Set-Content -LiteralPath $report -Encoding UTF8
  Get-Content -LiteralPath $report
  Write-Warning 'NOT-COVERED: hosted runner did not establish a usable Medium-token interactive task. This observation is not a protected-update pass.'
}finally{Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue}
