#Requires -Version 5.1
<#
.SYNOPSIS
    Local hourly tick for the hosted omp-settings-ru maintenance pipeline.

.DESCRIPTION
    One tick decides whether the hosted `upstream-watch` pipeline has anything to do and, if it
    does, dispatches it once. The watcher never picks a release version, never reruns, merges,
    tags or publishes: it only reads accepted `main` state, the npm registry and the owned pull
    requests, and asks the hosted pipeline to look.

    Decisions (also printed as one JSON line):
        busy                      another tick holds the named mutex; exit 0
        workflow-disabled         upstream-watch is not active; exit 0
        paused                    MAINTENANCE_PAUSED=true; exit 0
        active-run                a run of upstream-watch is queued/running; exit 0
        no-work                   published state already equals the registry window; exit 0
        cooldown                  a run or a previous intent is younger than 60 minutes; exit 0
        dispatched                one dispatch was accepted; exit 0
        dispatch                  dry run: a dispatch would be sent; exit 0
        <error code>              read/auth/dispatch failure; exit 1

    Runtime copy, config, state and log live in
    %LOCALAPPDATA%\omp-settings-ru\maintenance and are written by
    scripts/install-maintenance-watch.ps1. The mutable checkout is never executed from a task.

.PARAMETER Once
    Run exactly one tick. This is the only tick mode and the default.

.PARAMETER DryRun
    Read-only: GET requests only, no state, no log, no dispatch, no task changes.

.PARAMETER Status
    Prints local state and scheduled-task status. No network writes.
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$DryRun,
    [switch]$Status
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The tick prints one JSON line. Windows PowerShell 5.1 otherwise encodes redirected stdout with the
# console code page, which would corrupt paths that contain non-ASCII characters.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:TaskName = 'omp-settings-ru-upstream-watch'
$script:MutexName = 'Local\omp-settings-ru-maintenance'
$script:LogLimitBytes = 1048576
$script:CooldownMinutes = 60
$script:RegistryLimitBytes = 33554432
$script:RegistryTimeoutMs = 30000
$script:StablePattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'
$script:GhPath = $null
$script:StateInvalid = $false
$script:ActiveRunStatuses = @('queued', 'in_progress', 'waiting', 'pending', 'requested')

function Get-WatchRoot {
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if ([string]::IsNullOrWhiteSpace($localAppData)) { throw 'localappdata-unavailable' }
    return [IO.Path]::Combine($localAppData, 'omp-settings-ru', 'maintenance')
}

function Get-PropertyValue {
    param($InputObject, [string]$Name)
    if ($null -eq $InputObject) { return }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) { Write-Output -NoEnumerate $InputObject[$Name] }
        return
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return }
    # -NoEnumerate keeps an empty JSON array distinguishable from a missing field.
    Write-Output -NoEnumerate $property.Value
}

function Get-WatchCode {
    param($ErrorRecord)
    $message = ''
    if ($null -ne $ErrorRecord) {
        if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $message = [string]$ErrorRecord.Exception.Message }
        else { $message = [string]$ErrorRecord }
    }
    if ([string]::IsNullOrEmpty($message) -or $message.Length -gt 120) { return 'unexpected-failure' }
    if ($message -match '^[a-z][a-z0-9-]*(:[A-Za-z0-9._-]+)?$') { return $message }
    return 'unexpected-failure'
}

function Get-HttpStatus {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $null }
    if ($Text -match 'HTTP\s+([1-5][0-9][0-9])') { return $Matches[1] }
    return $null
}

function Protect-WatchText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $sanitized = [regex]::Replace($Text, '(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)', '[redacted]')
    $sanitized = [regex]::Replace($sanitized, '(?i)(bearer\s+)[^\s"]+', '$1[redacted]')
    if ($sanitized.Length -gt 2000) { $sanitized = $sanitized.Substring(0, 2000) }
    return $sanitized
}

function Read-WatchConfig {
    param([string]$Root)
    $path = [IO.Path]::Combine($Root, 'config.json')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'watch-config-missing' }
    $value = $null
    try { $value = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path)) } catch { throw 'watch-config-invalid' }
    if ($null -eq $value -or $value -is [System.Array]) { throw 'watch-config-invalid' }
    $names = @($value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    $expected = @('branch', 'gh', 'registry', 'repository', 'schemaVersion', 'workflow')
    if (($names -join ',') -ne ($expected -join ',')) { throw 'watch-config-invalid' }
    if ((Get-PropertyValue $value 'schemaVersion') -ne 1) { throw 'watch-config-invalid' }
    $repository = [string](Get-PropertyValue $value 'repository')
    if ($repository -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { throw 'watch-config-invalid' }
    $branch = [string](Get-PropertyValue $value 'branch')
    if ($branch -ne 'main') { throw 'watch-config-invalid' }
    $workflow = [string](Get-PropertyValue $value 'workflow')
    if ($workflow -ne 'upstream-watch.yml') { throw 'watch-config-invalid' }
    $registry = [string](Get-PropertyValue $value 'registry')
    $uri = $null
    if (-not [Uri]::TryCreate($registry, [UriKind]::Absolute, [ref]$uri)) { throw 'watch-config-invalid' }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { throw 'watch-config-invalid' }
    $gh = [string](Get-PropertyValue $value 'gh')
    if ([string]::IsNullOrWhiteSpace($gh)) { throw 'gh-not-found' }
    if (-not (Test-Path -LiteralPath $gh -PathType Leaf)) { throw 'gh-not-found' }
    return [pscustomobject]@{
        Repository = $repository
        Branch = $branch
        Workflow = $workflow
        Registry = $registry.TrimEnd('/')
        Gh = $gh
    }
}

function Read-WatchState {
    param([string]$Root)
    $path = [IO.Path]::Combine($Root, 'state.json')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $value = $null
    try { $value = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path)) } catch { $value = $null }
    if ($null -eq $value -or $value -is [System.Array] -or (Get-PropertyValue $value 'schemaVersion') -ne 1) {
        $script:StateInvalid = $true
        return $null
    }
    return $value
}

function Save-WatchState {
    param([string]$Root, $State)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    $path = [IO.Path]::Combine($Root, 'state.json')
    $temp = [IO.Path]::Combine($Root, 'state.json.tmp')
    $json = ConvertTo-Json -InputObject $State -Depth 4
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, $encoding)
    Move-Item -LiteralPath $temp -Destination $path -Force
}

function Add-WatchLog {
    param([string]$Root, [string]$Decision, [hashtable]$Fields)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    $path = [IO.Path]::Combine($Root, 'watch.log')
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $length = (Get-Item -LiteralPath $path).Length
        if ($length -ge $script:LogLimitBytes) {
            Move-Item -LiteralPath $path -Destination ([IO.Path]::Combine($Root, 'watch.log.1')) -Force
        }
    }
    $entry = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        decision = $Decision
    }
    foreach ($key in @($Fields.Keys | Sort-Object)) {
        $value = $Fields[$key]
        if ($null -ne $value) { $entry[$key] = $value }
    }
    $line = Protect-WatchText (ConvertTo-Json -InputObject $entry -Depth 4 -Compress)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::AppendAllText($path, $line + [Environment]::NewLine, $encoding)
}

function Invoke-GhRaw {
    param([Parameter(Mandatory = $true)][string[]]$GhArguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Merging the streams in memory keeps stderr available without a redirect cmdlet, which a
        # -WhatIf caller would suppress; error records stay distinguishable from real output.
        $merged = @(& $script:GhPath @GhArguments 2>&1)
        $code = $LASTEXITCODE
        $out = New-Object System.Collections.ArrayList
        $err = New-Object System.Collections.ArrayList
        foreach ($item in $merged) {
            if ($item -is [System.Management.Automation.ErrorRecord]) { [void]$err.Add([string]$item.Exception.Message) }
            else { [void]$out.Add([string]$item) }
        }
        return [pscustomobject]@{ Code = $code; Stdout = ($out -join [Environment]::NewLine); Stderr = ($err -join [Environment]::NewLine) }
    }
    finally { $ErrorActionPreference = $previousPreference }
}

function Invoke-GhApi {
    param([string]$Path, [switch]$Raw, [switch]$AllowNotFound)
    $ghArguments = @('api')
    if ($Raw) { $ghArguments += @('-H', 'Accept:application/vnd.github.raw') }
    $ghArguments += $Path
    $result = Invoke-GhRaw -GhArguments $ghArguments
    if ($result.Code -eq 0) { return $result.Stdout }
    $status = Get-HttpStatus ([string]$result.Stderr + ' ' + [string]$result.Stdout)
    if ($AllowNotFound -and $status -eq '404') { return $null }
    if ($null -ne $status) { throw ('read-failed:' + $status) }
    throw 'github-command-failed'
}

function Get-GhList {
    param([string]$Path, [string]$Key)
    $rows = New-Object System.Collections.ArrayList
    for ($page = 1; $page -le 100; $page++) {
        $separator = '?'
        if ($Path.IndexOf('?') -ge 0) { $separator = '&' }
        $text = Invoke-GhApi -Path ($Path + $separator + 'per_page=100&page=' + $page)
        $document = $null
        try { $document = ConvertFrom-Json -InputObject $text } catch { throw 'github-list-invalid' }
        if ($null -eq $document) { throw 'github-list-invalid' }
        $values = $document
        if ($Key) { $values = Get-PropertyValue $document $Key }
        if ($null -eq $values) { throw 'github-list-invalid' }
        $items = @($values)
        foreach ($item in $items) {
            if ($null -eq $item -or $item -is [string] -or $item -is [ValueType] -or $item -is [System.Array]) { throw 'github-list-invalid' }
            [void]$rows.Add($item)
        }
        if ($items.Count -lt 100) { return $rows.ToArray() }
    }
    throw 'github-pagination-exhausted'
}

function Read-RemoteFile {
    param([string]$Repository, [string]$Path, [string]$Ref)
    return Invoke-GhApi -Path ('repos/{0}/contents/{1}?ref={2}' -f $Repository, $Path, $Ref) -Raw
}

function Get-RegistryPackument {
    param([string]$Registry)
    $uri = $Registry + '/@oh-my-pi%2Fpi-coding-agent'
    $request = $null
    try { $request = [System.Net.HttpWebRequest]::Create($uri) } catch { throw 'registry-unavailable' }
    $request.Method = 'GET'
    $request.Timeout = $script:RegistryTimeoutMs
    $request.ReadWriteTimeout = $script:RegistryTimeoutMs
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'omp-settings-ru-maintenance-watch'
    $request.Accept = 'application/json'
    $response = $null
    try { $response = $request.GetResponse() }
    catch [System.Net.WebException] {
        $webResponse = $_.Exception.Response
        if ($null -ne $webResponse) {
            $status = [int]$webResponse.StatusCode
            if ($status -ge 300 -and $status -lt 400) { throw 'registry-redirect-forbidden' }
            throw ('registry-unavailable:' + $status)
        }
        throw 'registry-unavailable'
    }
    try {
        $stream = $response.GetResponseStream()
        $buffer = New-Object byte[] 65536
        $chunks = New-Object System.IO.MemoryStream
        $total = 0
        while ($true) {
            $read = $stream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $total = $total + $read
            if ($total -gt $script:RegistryLimitBytes) { throw 'registry-response-too-large' }
            $chunks.Write($buffer, 0, $read)
        }
        $text = [Text.Encoding]::UTF8.GetString($chunks.ToArray())
        $value = $null
        try { $value = ConvertFrom-Json -InputObject $text } catch { throw 'registry-window-invalid' }
        if ($null -eq $value) { throw 'registry-window-invalid' }
        return $value
    }
    finally { $response.Close() }
}

function Sort-Versions {
    param([string[]]$Versions)
    $ordered = @($Versions | Sort-Object -Property @{ Expression = {
                $parts = $_ -split '\.'
                '{0:D10}.{1:D10}.{2:D10}' -f [int]$parts[0], [int]$parts[1], [int]$parts[2]
            } })
    return $ordered
}

function Compare-StableVersion {
    param([string]$Left, [string]$Right)
    $leftParts = $Left -split '\.'
    $rightParts = $Right -split '\.'
    for ($index = 0; $index -lt 3; $index++) {
        $leftValue = [int]$leftParts[$index]
        $rightValue = [int]$rightParts[$index]
        if ($leftValue -lt $rightValue) { return -1 }
        if ($leftValue -gt $rightValue) { return 1 }
    }
    return 0
}

function Select-StableWindow {
    param($Packument)
    if ($null -eq $Packument) { throw 'registry-window-invalid' }
    if ($Packument -is [System.Array] -or $Packument -is [string] -or $Packument -is [ValueType]) { throw 'registry-window-invalid' }
    $versions = Get-PropertyValue $Packument 'versions'
    if ($null -eq $versions) { throw 'registry-window-invalid' }
    if ($versions -is [System.Array] -or $versions -is [string] -or $versions -is [ValueType]) { throw 'registry-window-invalid' }
    $stable = New-Object System.Collections.ArrayList
    foreach ($property in $versions.PSObject.Properties) {
        $entry = $property.Value
        if ($null -eq $entry -or $entry -is [System.Array] -or $entry -is [string] -or $entry -is [ValueType]) { throw 'registry-window-invalid' }
        if ($property.Name.Contains('-')) { continue }
        if ($property.Name -notmatch $script:StablePattern) { continue }
        [void]$stable.Add($property.Name)
    }
    $ordered = @(Sort-Versions -Versions @($stable))
    $tags = Get-PropertyValue $Packument 'dist-tags'
    if ($null -eq $tags -or $tags -is [System.Array] -or $tags -is [string] -or $tags -is [ValueType]) { throw 'registry-window-invalid' }
    $latest = Get-PropertyValue $tags 'latest'
    if (-not ($latest -is [string])) { throw 'registry-window-invalid' }
    if ($latest -notmatch $script:StablePattern) { throw 'registry-window-invalid' }
    if ($ordered.Count -eq 0) { throw 'registry-window-invalid' }
    if (-not ($ordered -contains $latest)) { throw 'registry-window-invalid' }
    $take = 3
    if ($ordered.Count -lt $take) { $take = $ordered.Count }
    return @($ordered | Select-Object -Last $take)
}

function Test-WithinMinutes {
    param($Timestamp, [int]$Minutes)
    if (-not ($Timestamp -is [string])) { return $false }
    if ([string]::IsNullOrWhiteSpace($Timestamp)) { return $false }
    $value = [DateTime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    if (-not [DateTime]::TryParse($Timestamp, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$value)) { return $false }
    $elapsed = ((Get-Date).ToUniversalTime() - $value.ToUniversalTime()).TotalMinutes
    return ($elapsed -lt $Minutes)
}

function Get-ReleaseVersionFromBody {
    param([string]$Body)
    if ([string]::IsNullOrEmpty($Body)) { return $null }
    $begin = '<!-- omp-maintenance:v1 -->'
    $end = '<!-- /omp-maintenance -->'
    $start = $Body.IndexOf($begin, [StringComparison]::Ordinal)
    if ($start -lt 0) { return $null }
    $payloadStart = $start + $begin.Length
    $finish = $Body.IndexOf($end, $payloadStart, [StringComparison]::Ordinal)
    if ($finish -lt 0) { return $null }
    if ($Body.IndexOf($begin, $payloadStart, [StringComparison]::Ordinal) -ge 0) { return $null }
    if ($Body.IndexOf($end, $finish + $end.Length, [StringComparison]::Ordinal) -ge 0) { return $null }
    $identity = $null
    try { $identity = ConvertFrom-Json -InputObject ($Body.Substring($payloadStart, $finish - $payloadStart).Trim()) } catch { return $null }
    $releaseVersion = Get-PropertyValue $identity 'releaseVersion'
    if (-not ($releaseVersion -is [string])) { return $null }
    if ($releaseVersion -notmatch $script:StablePattern) { return $null }
    return $releaseVersion
}

function New-TickDetails {
    return [ordered]@{
        baseSha = $null
        latest = $null
        window = @()
        active = @()
        pin = $null
        reason = $null
        dispatched = $false
    }
}

function New-TickResult {
    param([string]$Decision, [int]$ExitCode, $State, $Details)
    return [pscustomobject]@{ Decision = $Decision; ExitCode = $ExitCode; State = $State; Details = $Details }
}

function Get-OwnedCandidateState {
    param([pscustomobject]$Config, [string]$ControllerLogin)
    $pulls = @(Get-GhList -Path ('repos/{0}/pulls?state=all&sort=updated&direction=desc' -f $Config.Repository))
    $pending = New-Object System.Collections.ArrayList
    foreach ($pull in $pulls) {
        $reference = [string](Get-PropertyValue (Get-PropertyValue $pull 'head') 'ref')
        if (-not $reference.StartsWith('upgrade/omp-')) { continue }
        $mergedAt = Get-PropertyValue $pull 'merged_at'
        if ([string](Get-PropertyValue $pull 'state') -eq 'closed' -and $null -eq $mergedAt) { continue }
        $author = Get-PropertyValue (Get-PropertyValue $pull 'user') 'login'
        $baseReference = [string](Get-PropertyValue (Get-PropertyValue $pull 'base') 'ref')
        if ([string]$author -ne $ControllerLogin -or $baseReference -ne 'main') { throw 'maintenance-pr-ownership-conflict' }
        if ($null -eq $mergedAt) { [void]$pending.Add('open'); continue }
        $releaseVersion = Get-ReleaseVersionFromBody -Body ([string](Get-PropertyValue $pull 'body'))
        if ($null -eq $releaseVersion) { [void]$pending.Add('unknown'); continue }
        $releaseText = Invoke-GhApi -Path ('repos/{0}/releases/tags/v{1}' -f $Config.Repository, $releaseVersion) -AllowNotFound
        if ($null -eq $releaseText) { [void]$pending.Add('unreleased'); continue }
        $release = ConvertFrom-Json -InputObject $releaseText
        $published = $null -ne (Get-PropertyValue $release 'published_at')
        $tagName = [string](Get-PropertyValue $release 'tag_name')
        if ((Get-PropertyValue $release 'draft') -ne $false -or -not $published -or $tagName -ne ('v' + $releaseVersion)) {
            [void]$pending.Add('unreleased')
        }
    }
    if ($pending.Count -gt 1) { throw 'multiple-owned-candidates' }
    return $pending.Count
}

function Invoke-WatchTick {
    param([pscustomobject]$Config, [string]$Root, [bool]$DryRun)
    $script:GhPath = $Config.Gh
    $state = [ordered]@{
        schemaVersion = 1
        lastIntentAt = $null
        lastDispatchAt = $null
        baseSha = $null
        latest = $null
        decision = 'tick'
        lastError = $null
    }
    $details = New-TickDetails

    try {
        if ([Environment]::GetEnvironmentVariable('MAINTENANCE_GH_TOKEN')) { throw 'maintenance-token-forbidden' }

        $previous = Read-WatchState -Root $Root
        $state.lastIntentAt = Get-PropertyValue $previous 'lastIntentAt'
        $state.lastDispatchAt = Get-PropertyValue $previous 'lastDispatchAt'
        $state.baseSha = Get-PropertyValue $previous 'baseSha'
        $state.latest = Get-PropertyValue $previous 'latest'

        $auth = Invoke-GhRaw -GhArguments @('auth', 'status')
        if ($auth.Code -ne 0) { throw 'gh-auth-failed' }

        $workflowText = Invoke-GhApi -Path ('repos/{0}/actions/workflows/{1}' -f $Config.Repository, $Config.Workflow)
        $workflow = $null
        try { $workflow = ConvertFrom-Json -InputObject $workflowText } catch { throw 'workflow-state-invalid' }
        $workflowState = [string](Get-PropertyValue $workflow 'state')
        if ($workflowState -ne 'active') {
            $state.decision = 'workflow-disabled'
            $details.reason = 'workflow-state-' + $workflowState
            return New-TickResult 'workflow-disabled' 0 $state $details
        }

        $variables = $null
        try { $variables = Get-GhList -Path ('repos/{0}/actions/variables' -f $Config.Repository) -Key 'variables' }
        catch { throw 'maintenance-pause-unreadable' }
        $pauseFound = $false
        $pauseValue = $null
        foreach ($variable in @($variables)) {
            if ([string](Get-PropertyValue $variable 'name') -eq 'MAINTENANCE_PAUSED') {
                $pauseFound = $true
                $pauseValue = [string](Get-PropertyValue $variable 'value')
            }
        }
        if ($pauseFound) {
            if ($pauseValue -eq 'true') {
                $state.decision = 'paused'
                return New-TickResult 'paused' 0 $state $details
            }
            if ($pauseValue -ne 'false') { throw 'maintenance-pause-invalid' }
        }

        $runs = @(Get-GhList -Path ('repos/{0}/actions/workflows/{1}/runs' -f $Config.Repository, $Config.Workflow) -Key 'workflow_runs')
        foreach ($run in $runs) {
            if ($script:ActiveRunStatuses -contains [string](Get-PropertyValue $run 'status')) {
                $state.decision = 'active-run'
                return New-TickResult 'active-run' 0 $state $details
            }
        }

        $commitText = Invoke-GhApi -Path ('repos/{0}/commits/{1}' -f $Config.Repository, $Config.Branch)
        $commit = $null
        try { $commit = ConvertFrom-Json -InputObject $commitText } catch { throw 'main-sha-invalid' }
        $baseSha = [string](Get-PropertyValue $commit 'sha')
        if ($baseSha -notmatch '^[0-9a-f]{40}$') { throw 'main-sha-invalid' }
        $details.baseSha = $baseSha

        $package = $null
        try { $package = ConvertFrom-Json -InputObject (Read-RemoteFile -Repository $Config.Repository -Path 'package.json' -Ref $Config.Branch) } catch { throw 'accepted-package-invalid' }
        $pin = Get-PropertyValue (Get-PropertyValue $package 'devDependencies') '@oh-my-pi/pi-coding-agent'
        if (-not ($pin -is [string]) -or $pin -notmatch $script:StablePattern) { throw 'accepted-pin-invalid' }
        $details.pin = $pin

        $policy = $null
        try { $policy = ConvertFrom-Json -InputObject (Read-RemoteFile -Repository $Config.Repository -Path 'maintenance.config.json' -Ref $Config.Branch) } catch { throw 'controller-policy-invalid' }
        $controllerLogin = Get-PropertyValue (Get-PropertyValue $policy 'controller') 'controllerLogin'
        if (-not ($controllerLogin -is [string]) -or [string]::IsNullOrWhiteSpace($controllerLogin)) { throw 'controller-policy-invalid' }

        $support = $null
        try { $support = ConvertFrom-Json -InputObject (Read-RemoteFile -Repository $Config.Repository -Path 'test/fixtures/host-snapshots/supported-hosts.json' -Ref $Config.Branch) } catch { throw 'supported-hosts-invalid' }
        $rows = Get-PropertyValue $support 'versions'
        if ($null -eq $rows -or $rows -is [string] -or $rows -is [ValueType]) { throw 'supported-hosts-invalid' }
        $active = New-Object System.Collections.ArrayList
        foreach ($row in @($rows)) {
            $version = Get-PropertyValue $row 'version'
            if (-not ($version -is [string])) { throw 'supported-hosts-invalid' }
            if ($version -notmatch $script:StablePattern) { throw 'supported-hosts-invalid' }
            [void]$active.Add($version)
        }
        $activeSorted = @(Sort-Versions -Versions @($active))
        $details.active = $activeSorted

        $packument = Get-RegistryPackument -Registry $Config.Registry
        $window = @(Select-StableWindow -Packument $packument)
        $details.window = $window
        $latest = [string](Get-PropertyValue (Get-PropertyValue $packument 'dist-tags') 'latest')
        $details.latest = $latest
        $state.latest = $latest
        $state.baseSha = $baseSha

        $pendingCount = Get-OwnedCandidateState -Config $Config -ControllerLogin $controllerLogin

        $needsDispatch = $false
        if ($pendingCount -gt 0) {
            $needsDispatch = $true
            $details.reason = 'owned-candidate-pending'
        }
        elseif (($activeSorted -join ',') -ne ($window -join ',')) {
            $needsDispatch = $true
            $details.reason = 'support-window-mismatch'
        }
        elseif ((Compare-StableVersion -Left $pin -Right ([string]$window[$window.Count - 1])) -ne 0) {
            $needsDispatch = $true
            $details.reason = 'main-pin-mismatch'
        }

        if (-not $needsDispatch) {
            $state.decision = 'no-work'
            return New-TickResult 'no-work' 0 $state $details
        }

        $recent = $false
        foreach ($run in $runs) {
            if (Test-WithinMinutes -Timestamp (Get-PropertyValue $run 'created_at') -Minutes $script:CooldownMinutes) { $recent = $true; break }
        }
        if ($recent) {
            $state.decision = 'cooldown'
            $details.reason = 'recent-run'
            return New-TickResult 'cooldown' 0 $state $details
        }
        if (Test-WithinMinutes -Timestamp $state.lastIntentAt -Minutes $script:CooldownMinutes) {
            $state.decision = 'cooldown'
            $details.reason = 'recent-intent'
            return New-TickResult 'cooldown' 0 $state $details
        }
        if (Test-WithinMinutes -Timestamp $state.lastDispatchAt -Minutes $script:CooldownMinutes) {
            $state.decision = 'cooldown'
            $details.reason = 'recent-dispatch'
            return New-TickResult 'cooldown' 0 $state $details
        }

        $state.lastIntentAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $state.decision = 'dispatch-intent'
        if ($DryRun) {
            $state.decision = 'dispatch'
            return New-TickResult 'dispatch' 0 $state $details
        }
        Save-WatchState -Root $Root -State $state

        $dispatch = Invoke-GhRaw -GhArguments @('workflow', 'run', $Config.Workflow, '--repo', $Config.Repository, '--ref', $Config.Branch)
        if ($dispatch.Code -eq 0) {
            $state.lastDispatchAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            $state.decision = 'dispatched'
            $details.dispatched = $true
            return New-TickResult 'dispatched' 0 $state $details
        }
        $status = Get-HttpStatus ([string]$dispatch.Stderr + ' ' + [string]$dispatch.Stdout)
        if ($null -ne $status) { throw ('dispatch-failed:' + $status) }
        throw 'dispatch-uncertain'
    }
    catch {
        $code = Get-WatchCode $_
        $state.decision = $code
        $state.lastError = $code
        return New-TickResult $code 1 $state $details
    }
}

function Write-WatchOutput {
    param([pscustomobject]$Result, [bool]$IsDryRun, [string]$Root)
    $details = $Result.Details
    $window = @()
    $active = @()
    if ($null -ne $details) {
        $value = Get-PropertyValue $details 'window'
        if ($null -ne $value) { $window = @($value) }
        $value = Get-PropertyValue $details 'active'
        if ($null -ne $value) { $active = @($value) }
    }
    $payload = [ordered]@{
        decision = $Result.Decision
        exitCode = $Result.ExitCode
        dryRun = $IsDryRun
        root = $Root
        baseSha = Get-PropertyValue $details 'baseSha'
        latest = Get-PropertyValue $details 'latest'
        window = $window
        active = $active
        pin = Get-PropertyValue $details 'pin'
        reason = Get-PropertyValue $details 'reason'
        dispatched = [bool](Get-PropertyValue $details 'dispatched')
    }
    Write-Output (ConvertTo-Json -InputObject $payload -Depth 5 -Compress)
}

function Show-WatchStatus {
    param([string]$Root)
    $state = $null
    $statePath = [IO.Path]::Combine($Root, 'state.json')
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { $state = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($statePath)) } catch { $state = $null }
    }
    $task = $null
    $taskError = $null
    try {
        foreach ($candidate in @(Get-ScheduledTask -ErrorAction Stop)) {
            if ([string]$candidate.TaskName -eq $script:TaskName) { $task = $candidate }
        }
    }
    catch { $taskError = 'scheduled-tasks-unavailable' }
    $taskState = $null
    $taskInfo = $null
    if ($null -ne $task) {
        $taskState = [string]$task.State
        try {
            $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction Stop
            $taskInfo = [ordered]@{
                lastRunTime = [string]$info.LastRunTime
                lastTaskResult = [int]$info.LastTaskResult
                nextRunTime = [string]$info.NextRunTime
            }
        }
        catch { $taskInfo = $null }
    }
    $payload = [ordered]@{
        root = $Root
        taskName = $script:TaskName
        installed = ($null -ne $task)
        taskError = $taskError
        taskState = $taskState
        taskInfo = $taskInfo
        config = (Test-Path -LiteralPath ([IO.Path]::Combine($Root, 'config.json')) -PathType Leaf)
        watcher = (Test-Path -LiteralPath ([IO.Path]::Combine($Root, 'watch.ps1')) -PathType Leaf)
        state = $state
    }
    Write-Output (ConvertTo-Json -InputObject $payload -Depth 6 -Compress)
}

function Invoke-Watch {
    if ($DryRun -and $Status) { Write-Output (ConvertTo-Json -InputObject ([ordered]@{ decision = 'mode-conflict'; exitCode = 1 }) -Compress); exit 1 }
    $root = Get-WatchRoot

    if ($Status) {
        Show-WatchStatus -Root $root
        exit 0
    }

    $mutex = New-Object System.Threading.Mutex -ArgumentList $false, $script:MutexName
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) {
            Write-WatchOutput -Result (New-TickResult 'busy' 0 $null (New-TickDetails)) -IsDryRun ([bool]$DryRun) -Root $root
            exit 0
        }

        $result = $null
        try {
            $config = Read-WatchConfig -Root $root
            $result = Invoke-WatchTick -Config $config -Root $root -DryRun ([bool]$DryRun)
        }
        catch {
            $code = Get-WatchCode $_
            $state = [ordered]@{
                schemaVersion = 1
                lastIntentAt = $null
                lastDispatchAt = $null
                baseSha = $null
                latest = $null
                decision = $code
                lastError = $code
            }
            $previous = $null
            try { $previous = Read-WatchState -Root $root } catch { $previous = $null }
            $state.lastIntentAt = Get-PropertyValue $previous 'lastIntentAt'
            $state.lastDispatchAt = Get-PropertyValue $previous 'lastDispatchAt'
            $state.baseSha = Get-PropertyValue $previous 'baseSha'
            $state.latest = Get-PropertyValue $previous 'latest'
            $result = New-TickResult $code 1 $state (New-TickDetails)
        }

        if (-not $DryRun) {
            Save-WatchState -Root $root -State $result.State
            $windowValues = Get-PropertyValue $result.Details 'window'
            $activeValues = Get-PropertyValue $result.Details 'active'
            $fields = @{
                baseSha = Get-PropertyValue $result.Details 'baseSha'
                latest = Get-PropertyValue $result.Details 'latest'
                window = (@($windowValues) -join ',')
                active = (@($activeValues) -join ',')
                reason = Get-PropertyValue $result.Details 'reason'
                exitCode = $result.ExitCode
                stateInvalid = [bool]$script:StateInvalid
            }
            Add-WatchLog -Root $root -Decision $result.Decision -Fields $fields
        }

        Write-WatchOutput -Result $result -IsDryRun ([bool]$DryRun) -Root $root
        exit $result.ExitCode
    }
    finally {
        if ($acquired) { [void]$mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Dot-sourcing exposes the pure helpers (window selection) without running a tick.
if ($MyInvocation.InvocationName -ne '.') { Invoke-Watch }
