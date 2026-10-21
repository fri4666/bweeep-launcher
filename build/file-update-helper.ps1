param([Parameter(Mandatory = $true)][string]$PlanPath)

$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($plan.id -notmatch '^[0-9a-fA-F-]{36}$' -or $plan.parentPid -notmatch '^\d+$') { throw 'Invalid update plan' }
$root = [System.IO.Path]::GetFullPath($plan.root).TrimEnd('\')
$staged = [System.IO.Path]::GetFullPath($plan.staged).TrimEnd('\')
$backup = Join-Path $root ('.bweeep-update-backup-' + $plan.id)

function Resolve-UpdatePath([string]$base, [string]$relative) {
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^/|\\|:|\x00|(^|/)\.\.?(/|$))') {
    throw "Invalid update path: $relative"
  }
  $target = [System.IO.Path]::GetFullPath((Join-Path $base ($relative.Replace('/', '\'))))
  if (-not $target.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Update path escapes installation: $relative"
  }
  return $target
}

$applied = New-Object System.Collections.ArrayList
try {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while (Get-Process -Id $plan.parentPid -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Launcher did not exit before update timeout' }
    Start-Sleep -Milliseconds 250
  }

  # Recheck staged bytes after the launcher exits. A partial or modified download
  # must not become executable, even if it changed after the first verification.
  foreach ($item in $plan.changed) {
    $source = Resolve-UpdatePath $staged $item.path
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing staged file: $($item.path)" }
    $actual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $item.sha256) { throw "Staged file hash mismatch: $($item.path)" }
  }

  foreach ($item in $plan.changed) {
    $target = Resolve-UpdatePath $root $item.path
    $source = Resolve-UpdatePath $staged $item.path
    $old = Resolve-UpdatePath $backup $item.path
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = $target + '.bweeep-new-' + $plan.id
    Copy-Item -LiteralPath $source -Destination $temporary -Force
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $old) -Force | Out-Null
      [System.IO.File]::Replace($temporary, $target, $old)
      [void]$applied.Add(@{ path = $item.path; existed = $true })
    } else {
      [System.IO.File]::Move($temporary, $target)
      [void]$applied.Add(@{ path = $item.path; existed = $false })
    }
  }
  foreach ($relative in $plan.removed) {
    $target = Resolve-UpdatePath $root $relative
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    $old = Resolve-UpdatePath $backup $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $old) -Force | Out-Null
    [System.IO.File]::Move($target, $old)
    [void]$applied.Add(@{ path = $relative; existed = $true; removed = $true })
  }
  Start-Process -FilePath (Join-Path $root 'Bweeep.exe') -WorkingDirectory $root
} catch {
  $failure = $_
  try {
    for ($index = $applied.Count - 1; $index -ge 0; $index--) {
      $item = $applied[$index]
      $target = Resolve-UpdatePath $root $item.path
      $old = Resolve-UpdatePath $backup $item.path
      if ($item.existed -and (Test-Path -LiteralPath $old -PathType Leaf)) {
        Copy-Item -LiteralPath $old -Destination $target -Force
      } elseif (-not $item.existed -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        Remove-Item -LiteralPath $target -Force
      }
    }
  } catch {
    $_ | Out-File -LiteralPath (Join-Path $staged 'rollback-error.txt') -Encoding UTF8
  }
  Start-Process -FilePath (Join-Path $root 'Bweeep.exe') -WorkingDirectory $root
  throw $failure
}
