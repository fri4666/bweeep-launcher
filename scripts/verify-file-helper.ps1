$ErrorActionPreference = 'Stop'
$base = Join-Path $env:RUNNER_TEMP ('bweeep-file-update-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $base 'installed'
$stage = Join-Path $base 'stage'
New-Item -ItemType Directory -Path (Join-Path $root 'data'), (Join-Path $stage 'data') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\where.exe') -Destination (Join-Path $root 'Bweeep.exe')
Set-Content -LiteralPath (Join-Path $root 'data\value.txt') -Value 'old' -NoNewline
Set-Content -LiteralPath (Join-Path $root 'data\obsolete.txt') -Value 'obsolete' -NoNewline
Set-Content -LiteralPath (Join-Path $stage 'data\value.txt') -Value 'new' -NoNewline
Set-Content -LiteralPath (Join-Path $stage 'data\added.txt') -Value 'added' -NoNewline
$changed = @('data/value.txt', 'data/added.txt') | ForEach-Object {
  @{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $stage $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$planPath = Join-Path $base 'plan.json'
$plan = @{ id = [guid]::NewGuid().ToString(); root = $root; staged = $stage; parentPid = 2147483647; changed = $changed; removed = @('data/obsolete.txt') }
$plan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $planPath -Encoding UTF8
& (Join-Path $PSScriptRoot '..\build\file-update-helper.ps1') -PlanPath $planPath
if ((Get-Content -LiteralPath (Join-Path $root 'data\value.txt') -Raw) -ne 'new') { throw 'existing file was not replaced' }
if ((Get-Content -LiteralPath (Join-Path $root 'data\added.txt') -Raw) -ne 'added') { throw 'new file was not installed' }
if (Test-Path -LiteralPath (Join-Path $root 'data\obsolete.txt')) { throw 'obsolete app file was not removed' }

$plan.changed[0].sha256 = '0' * 64
$plan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $planPath -Encoding UTF8
$rejected = $false
try { & (Join-Path $PSScriptRoot '..\build\file-update-helper.ps1') -PlanPath $planPath } catch { $rejected = $true }
if (-not $rejected) { throw 'tampered staged file was accepted' }
if ((Get-Content -LiteralPath (Join-Path $root 'data\value.txt') -Raw) -ne 'new') { throw 'tampered plan changed installed bytes' }
Write-Output 'windows-file-replacement=passed'
