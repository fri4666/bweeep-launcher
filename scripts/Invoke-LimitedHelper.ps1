param([string]$HelperPath,[string]$PlanPath,[string]$ReceiptPath)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Disposable Windows runner only'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$elevated=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$receipt=@{elevated=$elevated;phase='started';helperSha256=(Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash.ToLowerInvariant()}
try{& $HelperPath -PlanPath $PlanPath;$receipt.helperError=$null;$receipt.writeDenied=$false}catch{
  $receipt.helperError=$_.Exception.Message
  $receipt.writeDenied=($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception.Message -match 'access.+denied|액세스.+거부')
}
$plan=Get-Content -LiteralPath $PlanPath -Raw|ConvertFrom-Json
$receipt.actual=Get-Content -LiteralPath (Join-Path $plan.root 'data\value.txt') -Raw
if($elevated){$receipt.phase='not-covered';$receipt.reason='Task received elevated token despite RunLevel Limited'}
elseif($receipt.writeDenied -and $receipt.actual -eq 'old'){$receipt.phase='protected-write-denial-reproduced'}
else{$receipt.phase='not-covered';$receipt.reason='Default fixture ACL did not reproduce an inaccessible protected install'}
$receipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
