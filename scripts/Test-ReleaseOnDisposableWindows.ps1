param(
  [Parameter(Mandatory=$true)][ValidateSet('FreshNSIS','LegacyBridge','FileBridge','FixedFileBridge')][string]$Mode,
  [ValidateSet('x64','arm64')][string]$Architecture='x64',
  [string]$ExpectedStableVersion='0.1.40',
  [string]$ExpectedStableInstallerSha256,
  [string]$FileBaselineVersion='0.1.40-beta.4',
  [ValidateRange(1,15)][int]$UpdateTimeoutMinutes=15,
  [ValidateRange(1024,65535)][int]$InspectorPort=9229,
  [switch]$StagedCandidate,
  [switch]$TraceHelperFailure
)
$ErrorActionPreference='Stop'
if($ExpectedStableInstallerSha256 -and $ExpectedStableInstallerSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Optional stable SHA pin must be lowercase SHA-256'}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'NSIS tests require a disposable GitHub Windows runner' }
if ($env:RUNNER_ARCH -ine $Architecture) { throw 'A native runner matching the candidate architecture is required' }
if ($Architecture -eq 'arm64' -and $Mode -eq 'LegacyBridge') { throw 'Version 0.1.39 has no ARM64 installer; this migration is not applicable' }
$work=Join-Path $env:RUNNER_TEMP ('bweeep-release-proof-'+$Mode)
New-Item -ItemType Directory -Path $work -Force | Out-Null
$root=Join-Path $env:LOCALAPPDATA 'Programs\Bweeep'
if (Test-Path -LiteralPath $root) { throw 'Runner is not clean: Bweeep directory exists' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$elevated=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$receipt=@{mode=$Mode;arch=$Architecture;runnerArch=$env:RUNNER_ARCH; runner=$env:RUNNER_NAME; elevated=$elevated; root=$root; startedUtc=[DateTime]::UtcNow.ToString('o'); phase='preflight'; stagedCandidate=[bool]$StagedCandidate; helperTraceEnabled=[bool]$TraceHelperFailure; updateTimeoutMinutes=$UpdateTimeoutMinutes; sourceSha=$env:GITHUB_SHA; candidateInstallerSha256=$ExpectedStableInstallerSha256}
function Save-Receipt { $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $work 'receipt.json') -Encoding UTF8 }
function Installer-Name([string]$version) {
  $suffix=if($Architecture -eq 'arm64'){'-arm64'}else{''}
  return 'Bweeep-Setup-'+$version+$suffix+'.exe'
}
function Version-AtRoot {
  try{
    $metadata=& node (Join-Path $PSScriptRoot 'Read-InstalledPackage.cjs') $root
    if($LASTEXITCODE -ne 0){return $null}
    return ($metadata|ConvertFrom-Json).version
  }catch{return $null}
}
function Main-Processes {
  return @(Get-CimInstance Win32_Process -Filter "Name='Bweeep.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $root 'Bweeep.exe') -and $_.CommandLine -notmatch '--type=' })
}
function Owned-Processes {
  return @(Get-CimInstance Win32_Process -Filter "Name='Bweeep.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $root 'Bweeep.exe') } | ForEach-Object {
    $role='main';if($_.CommandLine -match '--type=([a-zA-Z0-9-]+)'){$role=$Matches[1]}
    @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;role=$role;creationDate=$_.CreationDate;executablePath=$_.ExecutablePath}
  })
}
# Read only this disposable installation's process metadata and update staging.
# Authentication/session files and arbitrary application log events are excluded.
function Save-Diagnostics([string]$phase) {
  try {
    $snapshot=@{at=[DateTime]::UtcNow.ToString('o');phase=$phase;installedVersion=Version-AtRoot;mainProcesses=@(Main-Processes | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath);ownedProcesses=@(Owned-Processes);installedChangedFiles=@();profiles=@()}
    foreach($relative in @($receipt.expectedChanged|Select-Object -First 10)){
      $target=Join-Path $root $relative
      if(Test-Path -LiteralPath $target -PathType Leaf){$item=Get-Item -LiteralPath $target;$snapshot.installedChangedFiles+=@{path=$relative;bytes=$item.Length;attributes=[string]$item.Attributes;writeUtc=$item.LastWriteTimeUtc.ToString('o')}}
    }
    $names=@('bweeep-launcher','Bweeep')
    if($baselineMetadata){$names+=@($baselineMetadata.userDataNames)}
    foreach($name in @($names | Sort-Object -Unique)) {
      if($name -notmatch '^[a-z0-9][a-z0-9 ._-]{0,80}$'){continue}
      $profileRoot=Join-Path $env:APPDATA $name
      $stageRoot=Join-Path $profileRoot 'launcher-update-stage'
      $profile=@{name=$name;exists=(Test-Path -LiteralPath $profileRoot);stageFiles=@();initializations=@();plans=@();originalApplyErrors=@()}
      if(Test-Path -LiteralPath $stageRoot){
        $profile.stageFiles=@(Get-ChildItem -LiteralPath $stageRoot -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 100 | ForEach-Object {@{path=$_.FullName.Substring($stageRoot.Length).TrimStart('\');bytes=$_.Length;writeUtc=$_.LastWriteTimeUtc.ToString('o')}})
        foreach($file in @(Get-ChildItem -LiteralPath $stageRoot -Recurse -Filter 'plan-*.json' -File -ErrorAction SilentlyContinue | Select-Object -First 4)){
          try{
            $plan=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
            if([IO.Path]::GetFullPath($plan.root).TrimEnd('\') -eq [IO.Path]::GetFullPath($root).TrimEnd('\')){
              $profile.plans+=@{id=$plan.id;parentPid=$plan.parentPid;root=$plan.root;staged=$plan.staged;changed=@($plan.changed|Select-Object path,size,sha256);removed=@($plan.removed)}
            }
          }catch{}
        }
        foreach($file in @(Get-ChildItem -LiteralPath $stageRoot -Recurse -Filter 'original-apply-error.json' -File -ErrorAction SilentlyContinue | Select-Object -First 4)){
          try{if($file.Length -le 16384){$errorRecord=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json;$profile.originalApplyErrors+=@($errorRecord|Select-Object message,innerMessage,type,innerType,hresult,innerHresult,line,category)}}catch{}
        }
      }
      $authLog=Join-Path $profileRoot 'logs\auth.jsonl'
      if(Test-Path -LiteralPath $authLog){
        $profile.initializations=@(Get-Content -LiteralPath $authLog -Tail 100 | ForEach-Object {try{$event=$_|ConvertFrom-Json;if($event.event -eq 'app.auth.initialized'){@{timestamp=$event.timestamp;pid=$event.pid;packaged=$event.packaged;logPath=$event.logPath}}}catch{}})
      }
      $snapshot.profiles+=@($profile)
    }
    $snapshot|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $work 'diagnostics.json') -Encoding UTF8
  }catch{
    @{at=[DateTime]::UtcNow.ToString('o');phase=$phase;error='Safe diagnostic snapshot failed'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'diagnostics-error.json') -Encoding UTF8
  }
}
function Resolve-Release([string]$version,[hashtable]$headers){
  $tag='v'+$version
  try{
    $release=Invoke-RestMethod -Uri ('https://api.github.com/repos/fri4666/bweeep-launcher/releases/tags/'+$tag) -Headers $headers
    if($release.tag_name -ne $tag){throw 'Release tag endpoint returned a different tag'}
    return @{release=$release;source='tag-endpoint'}
  }catch{
    if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404){throw}
  }
  # A draft without an existing Git tag can be absent from /releases/tags/.
  # Only authenticated release inventory is used as the exact-tag fallback.
  if(-not $headers.Authorization){throw 'Draft metadata fallback requires the runner contents-read token'}
  for($page=1;$page -le 3;$page++){
    $entries=Invoke-RestMethod -Uri ('https://api.github.com/repos/fri4666/bweeep-launcher/releases?per_page=100&page='+$page) -Headers $headers
    $releaseMatches=@($entries|Where-Object tag_name -eq $tag)
    if($releaseMatches.Count -gt 1){throw 'Ambiguous exact-tag release metadata'}
    if($releaseMatches.Count -eq 1){return @{release=$releaseMatches[0];source='authenticated-release-list-fallback'}}
    if($entries.Count -lt 100){break}
  }
  throw "Exact release tag not found: $tag"
}
function Download-Installer([string]$version,[string]$destination,[string]$pinnedSha='') {
  $apiHeaders=@{Accept='application/vnd.github+json'}
  if($env:GH_TOKEN){$apiHeaders.Authorization='Bearer '+$env:GH_TOKEN}
  if(($Mode -eq 'FreshNSIS' -and $version -eq $ExpectedStableVersion -and ($StagedCandidate -or -not $promoted)) -or ($StagedCandidate -and $Architecture -eq 'arm64' -and $Mode -eq 'FileBridge') -or $Mode -eq 'FixedFileBridge'){
    $extraSha=$pinnedSha;$digestSource=if($pinnedSha){'reviewed-pin'}else{'signed-archive'}
    $metadataSource='not-visible-to-read-token';$releaseId=$null;$assetId=$null
    try{
      $draftLookup=Resolve-Release $version $apiHeaders
      $draftAsset=@($draftLookup.release.assets|Where-Object name -eq (Installer-Name $version))
      if($draftAsset.Count -ne 1 -or $draftAsset[0].digest -notmatch '^sha256:([a-f0-9]{64})$'){throw 'Visible Draft installer metadata is ambiguous or lacks a digest'}
      $githubSha=$Matches[1]
      if($extraSha -and $extraSha -ne $githubSha){throw 'Reviewed pin differs from visible GitHub Draft digest'}
      $extraSha=$githubSha;$digestSource='github-asset';$metadataSource=$draftLookup.source
      $releaseId=$draftLookup.release.id;$assetId=$draftAsset[0].id
    }catch{
      if($_.Exception.Message -notlike 'Exact release tag not found:*'){throw}
    }
    # Read-only PR tokens may not expose Drafts. The public archive is already
    # signed with the pinned release key, so no stronger GitHub token is needed.
    $pinArgument=if($extraSha){$extraSha}else{'-'}
    & node (Join-Path $PSScriptRoot 'Download-SignedInstallerArchive.mjs') $destination $version (Join-Path $PSScriptRoot 'expected-update-public-key.pem') $work $pinArgument $digestSource $Architecture | Write-Host
    if($LASTEXITCODE -ne 0){throw 'Anonymous signed installer reconstruction failed before execution'}
    $download=Get-Content -LiteralPath (Join-Path $work 'installer-download.json') -Raw|ConvertFrom-Json
    return @{version=$version;sha256=$download.sha256;bytes=$download.bytes;source=$download.source;metadataSource=$metadataSource;releaseId=$releaseId;assetId=$assetId;signatureVerified=$download.signatureVerified;additionalDigestVerified=$download.additionalDigestVerified}
  }
  $lookup=Resolve-Release $version $apiHeaders
  $release=$lookup.release
  if ($release.draft -and $Mode -ne 'FreshNSIS') { throw 'Requested bridge installer is still draft' }
  $asset=@($release.assets | Where-Object name -eq (Installer-Name $version))
  if ($asset.Count -ne 1) { throw "Exactly one $Architecture installer asset required" }
  $sha=$pinnedSha
  if($pinnedSha -and $asset[0].digest -and $asset[0].digest -ne ('sha256:'+$pinnedSha)){throw 'Explicit SHA pin differs from current GitHub asset digest'}
  if (-not $sha) {
    if ($asset[0].digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Legacy installer digest missing; pin its verified SHA explicitly' }
    $sha=$Matches[1]
  }
  if($release.draft){
    if(-not $env:GH_TOKEN){throw 'Draft asset requires the disposable runner contents-read token'}
    $url=$asset[0].url
    Invoke-WebRequest -Uri $url -Headers @{Accept='application/octet-stream';Authorization=('Bearer '+$env:GH_TOKEN)} -OutFile $destination
  }else{
    $url=if($version -eq $ExpectedStableVersion){'https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-download?arch='+$Architecture}else{$asset[0].browser_download_url}
    Invoke-WebRequest -Uri $url -OutFile $destination
  }
  $actual=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sha) { throw "Installer hash mismatch: $version" }
  if($version -eq $ExpectedStableVersion){
    & node (Join-Path $PSScriptRoot 'Verify-InstallerArchive.mjs') $destination $version $sha (Join-Path $PSScriptRoot 'expected-update-public-key.pem') $work $Architecture | Write-Host
    if($LASTEXITCODE -ne 0){throw 'Archived installer signature/hash verification failed before execution'}
  }
  return @{version=$version; sha256=$actual; bytes=(Get-Item -LiteralPath $destination).Length; source=$url;metadataSource=$lookup.source;releaseId=$release.id;assetId=$asset[0].id}
}
function Install-NSIS([string]$installer) {
  $p=Start-Process -FilePath $installer -ArgumentList @('/S','/currentuser',('/D='+$root)) -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw "NSIS exit $($p.ExitCode)" }
}
try {
  if($ExpectedStableVersion -notmatch '^\d+\.\d+\.\d+$' -or $FileBaselineVersion -notmatch '^\d+\.\d+\.\d+(?:-beta\.\d+)?$'){throw 'Invalid fixed release version'}
  if($StagedCandidate -and -not $ExpectedStableInstallerSha256){throw 'Prepublication installation requires an explicit reviewed installer SHA-256 pin'}
  if($TraceHelperFailure -and (-not $StagedCandidate -or $Mode -ne 'FileBridge')){throw 'Helper error tracing is permitted only for staged file-update diagnostics'}
  Save-Receipt
  $latestHeaders=@{Accept='application/vnd.github+json'}
  if($env:GH_TOKEN){$latestHeaders.Authorization='Bearer '+$env:GH_TOKEN}
  $latest=Invoke-RestMethod -Uri 'https://api.github.com/repos/fri4666/bweeep-launcher/releases/latest' -Headers $latestHeaders
  $promoted=$latest.tag_name -eq ('v'+$ExpectedStableVersion) -and -not $latest.prerelease -and -not $latest.draft
  if(-not $promoted -and -not $StagedCandidate -and $Mode -ne 'FreshNSIS'){
    $receipt.phase='blocked';$receipt.dependency='Stable release must be published before an actual migration bridge can run; no installer/app was launched.'
    Save-Receipt;Write-Output $receipt.dependency;exit 0
  }
  $manifestUrl=if($promoted -and -not $StagedCandidate){'https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates/channels/stable/'+$Architecture+'.json'}else{'https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates/manifests/'+$ExpectedStableVersion+'/'+$Architecture+'/stable.json'}
  $receipt.manifestSource=$manifestUrl
  $baseline=if($Mode -eq 'LegacyBridge'){'0.1.39'}elseif($Mode -eq 'FileBridge'){$FileBaselineVersion}elseif($Mode -eq 'FixedFileBridge'){"${ExpectedStableVersion}-beta.1"}else{$ExpectedStableVersion}
  $installer=Join-Path $work (Installer-Name $baseline)
  $pin=if($baseline -eq $ExpectedStableVersion){$ExpectedStableInstallerSha256}else{''}
  $receipt.installer=Download-Installer $baseline $installer $pin
  Install-NSIS $installer
  $receipt.phase='installed-baseline'; $receipt.baseline=Version-AtRoot; Save-Receipt
  if ($receipt.baseline -ne $baseline) { throw "Baseline installation version mismatch: $($receipt.baseline)" }
  $baselineMetadata=(& node (Join-Path $PSScriptRoot 'Read-InstalledPackage.cjs') $root)|ConvertFrom-Json
  if($LASTEXITCODE -ne 0){throw 'Cannot read baseline application package metadata'}
  $receipt.baselineMetadata=$baselineMetadata
  if($StagedCandidate -and $Mode -eq 'LegacyBridge'){
    $candidateInstaller=Join-Path $work (Installer-Name $ExpectedStableVersion)
    & node (Join-Path $PSScriptRoot 'Download-SignedInstallerArchive.mjs') $candidateInstaller $ExpectedStableVersion (Join-Path $PSScriptRoot 'expected-update-public-key.pem') $work $ExpectedStableInstallerSha256 'reviewed-pin' $Architecture | Write-Host
    if($LASTEXITCODE -ne 0){throw 'Legacy candidate signed archive verification failed before serving'}
    $receipt.candidateInstaller=Get-Content -LiteralPath (Join-Path $work 'installer-download.json') -Raw|ConvertFrom-Json
  }
  $receipt.protocolRegistered=[bool](Test-Path 'HKCU:\Software\Classes\bwe-e-ep')
  if (-not $receipt.protocolRegistered) { throw 'Invite protocol not registered by real NSIS' }
  $pointer=Invoke-RestMethod -Uri $manifestUrl
  if ($pointer.version -ne $ExpectedStableVersion) { throw 'Stable channel version mismatch' }
  if ($pointer.arch -ne $Architecture) { throw 'Candidate manifest architecture mismatch' }
  $receipt.manifestSignature=$pointer.signature
  $before=@{}
  foreach($f in $pointer.files) {
    $p=Join-Path $root $f.path
    if(Test-Path -LiteralPath $p -PathType Leaf){$before[$f.path]=@{hash=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant();write=(Get-Item -LiteralPath $p).LastWriteTimeUtc.ToString('o')}}
  }
  $receipt.expectedChanged=@($pointer.files | Where-Object { -not $before.ContainsKey($_.path) -or $before[$_.path].hash -ne $_.sha256 } | ForEach-Object path)
  if($Mode -ne 'FreshNSIS') {
    if($StagedCandidate){
      # This exact root was absent at preflight. Stop only the clean runner's
      # baseline app before its isolated debugger launch; never a user process.
      foreach($owned in @(Main-Processes)){Stop-Process -Id $owned.ProcessId -Force;Wait-Process -Id $owned.ProcessId -Timeout 15 -ErrorAction SilentlyContinue}
      # The published x64 beta.4 helper predates the PS7 module-path fix. Only
      # that stock baseline gets the normal Explorer/Windows PowerShell child
      # environment; new fixed baselines retain the failing inherited path.
      $normalizeOldBaseline=$Architecture -eq 'x64' -and $Mode -eq 'FileBridge' -and $FileBaselineVersion -eq '0.1.40-beta.4'
      $originalModulePath=[Environment]::GetEnvironmentVariable('PSModulePath','Process')
      $receipt.baselineLaunchEnvironment=@{inheritedPSModulePathPresent=[bool]$originalModulePath;normalizationApplied=$normalizeOldBaseline;normalization=if($normalizeOldBaseline){'PSModulePath omitted only for this old baseline child to reproduce normal Windows launch'}else{'None; inherited PowerShell 7 module path retained'}}
      try{
        if($normalizeOldBaseline){[Environment]::SetEnvironmentVariable('PSModulePath',$null,'Process')}
        $started=Start-Process -FilePath (Join-Path $root 'Bweeep.exe') -ArgumentList @('--disable-gpu',('--inspect-brk=127.0.0.1:'+$InspectorPort)) -WorkingDirectory $root -WindowStyle Hidden -PassThru
      }finally{
        if($normalizeOldBaseline){[Environment]::SetEnvironmentVariable('PSModulePath',$originalModulePath,'Process')}
      }
      $receipt.launchedPid=$started.Id
      $observerArguments=@((Join-Path $PSScriptRoot 'Observe-PackagedUpdate.mjs'),$InspectorPort,$root,$ExpectedStableVersion,$work,$Mode)
      if($Mode -eq 'LegacyBridge'){$observerArguments+=@($candidateInstaller,$ExpectedStableInstallerSha256)}else{$observerArguments+=@('-','-')}
      $observerArguments+=@($(if($TraceHelperFailure){'trace'}else{'plain'}))
      $observer=Start-Process -FilePath (Get-Command node).Source -ArgumentList $observerArguments -WindowStyle Hidden -PassThru
      $receipt.observerPid=$observer.Id
      $receipt.updateFeedFixture=if($Mode -eq 'LegacyBridge'){'Only exact GitHub stable provider redirected to loopback feed serving the pinned, signed candidate installer'}else{'Only exact stable channel URL redirected to immutable signed candidate manifest in disposable packaged app memory'}
      $readyFile=Join-Path $work 'inspector-ready.json'
      $probeDeadline=[DateTime]::UtcNow.AddSeconds(75)
      while(-not(Test-Path -LiteralPath $readyFile)){
        $observer.Refresh()
        if($observer.HasExited){throw 'Packaged updater probe exited before candidate mapping; inspect inspector-diagnostics.json'}
        if([DateTime]::UtcNow -ge $probeDeadline){throw 'Packaged updater probe did not acknowledge candidate mapping'}
        Start-Sleep -Milliseconds 250
      }
      $probe=Get-Content -LiteralPath $readyFile -Raw|ConvertFrom-Json
      if($probe.pid -ne $started.Id -or $probe.targetVersion -ne $ExpectedStableVersion -or $probe.arch -ne $Architecture -or $probe.signatureBypass -ne $false -or $probe.helperTraceEnabled -ne [bool]$TraceHelperFailure){throw 'Candidate mapping acknowledgement differs from this test'}
      $receipt.probe=$probe
    }elseif((Main-Processes).Count -eq 0){$started=Start-Process -FilePath (Join-Path $root 'Bweeep.exe') -ArgumentList '--disable-gpu' -WindowStyle Hidden -PassThru;$receipt.launchedPid=$started.Id}
    $initial=@((Main-Processes)|ForEach-Object ProcessId)
    if($receipt.launchedPid){$initial+=@($receipt.launchedPid)}
    $receipt.initialMainPids=$initial;$receipt.phase='waiting-for-automatic-update';Save-Receipt
    $deadline=[DateTime]::UtcNow.AddMinutes($UpdateTimeoutMinutes)
    $nextDiagnostic=[DateTime]::MinValue
    while([DateTime]::UtcNow -lt $deadline){
      if((Version-AtRoot) -eq $ExpectedStableVersion){$now=Main-Processes;if($now.Count -gt 0 -and @($now|Where-Object{$initial -contains $_.ProcessId}).Count -eq 0){break}}
      if([DateTime]::UtcNow -ge $nextDiagnostic){Save-Diagnostics 'waiting-for-automatic-update';$nextDiagnostic=[DateTime]::UtcNow.AddSeconds(15)}
      Start-Sleep -Seconds 2
    }
    Save-Diagnostics 'automatic-update-wait-finished'
    if((Version-AtRoot) -ne $ExpectedStableVersion){throw 'Automatic update did not reach stable'}
    $new=Main-Processes
    if($new.Count -eq 0 -or @($new|Where-Object{$initial -contains $_.ProcessId}).Count -gt 0){throw 'Automatic restart not observed'}
    $receipt.finalMainPids=@($new|ForEach-Object ProcessId)
  }
  foreach($f in $pointer.files){
    $p=Join-Path $root $f.path
    if(-not(Test-Path -LiteralPath $p -PathType Leaf)){throw "Missing installed manifest file: $($f.path)"}
    if((Get-Item -LiteralPath $p).Length -ne $f.size -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f.sha256){throw "Installed file mismatch: $($f.path)"}
  }
  if($Mode -in @('FileBridge','FixedFileBridge')){
    $matchingPlans=@()
    foreach($appName in $baselineMetadata.userDataNames){
      $stageDir=Join-Path (Join-Path $env:APPDATA $appName) 'launcher-update-stage'
      foreach($candidate in @(Get-ChildItem -LiteralPath $stageDir -Recurse -Filter 'plan-*.json' -ErrorAction SilentlyContinue)){
        $candidatePlan=Get-Content -LiteralPath $candidate.FullName -Raw|ConvertFrom-Json
        if([IO.Path]::GetFullPath($candidatePlan.root).TrimEnd('\') -eq [IO.Path]::GetFullPath($root).TrimEnd('\')){$matchingPlans+=@{file=$candidate;plan=$candidatePlan}}
      }
    }
    if($matchingPlans.Count -ne 1){throw "Expected one real updater plan for the exact test installation; found $($matchingPlans.Count)"}
    $plan=$matchingPlans[0].plan
    $actual=@($plan.changed|ForEach-Object path|Sort-Object);$expected=@($receipt.expectedChanged|Sort-Object)
    if(Compare-Object $actual $expected){throw 'Helper changed set differs from pre-update hashes'}
    $receipt.actualChanged=$actual
    $unchanged=@($pointer.files|Where-Object{$receipt.expectedChanged -notcontains $_.path})
    foreach($f in $unchanged){if((Get-Item -LiteralPath (Join-Path $root $f.path)).LastWriteTimeUtc.ToString('o') -ne $before[$f.path].write){throw "Unchanged file rewritten: $($f.path)"}}
    $receipt.unchangedFilesUntouched=$unchanged.Count
    $plan|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $work 'actual-helper-plan.json') -Encoding UTF8
  }
  if(-not(Test-Path -LiteralPath (Join-Path $root 'resources\bweeep-update-public-key.pem'))){throw 'Public key absent'}
  if(-not(Test-Path -LiteralPath (Join-Path $root 'resources\file-update-helper.ps1'))){throw 'Helper absent'}
  & node (Join-Path $PSScriptRoot 'Verify-InstalledManifest.mjs') $root $work $ExpectedStableVersion $manifestUrl $Architecture
  if($LASTEXITCODE -ne 0){throw 'Installed signed manifest verification failed'}
  $receipt.verifiedFiles=$pointer.files.Count;$receipt.finalVersion=Version-AtRoot;$receipt.phase='passed'
  $receipt.coverage='Actual NSIS/automatic update on clean runner in writable per-user path; excludes protected Program Files and actual game-running behavior.'
  Save-Receipt
}catch{$receipt.phase='failed';$receipt.error=$_.Exception.Message;Save-Diagnostics 'failed';Save-Receipt;throw}
