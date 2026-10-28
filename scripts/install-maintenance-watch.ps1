#Requires -Version 5.1
<#
.SYNOPSIS
    Installs (or removes) the hourly omp-settings-ru maintenance watcher task.

.DESCRIPTION
    The installer resolves absolute tool paths once, verifies that the accepted `main` carries the
    same watcher bytes that would be installed, copies the watcher into
    %LOCALAPPDATA%\omp-settings-ru\maintenance and registers one per-user scheduled task that runs
    the installed copy every hour.

    It never edits a checkout, never runs git commands, never changes execution policy and never
    overwrites a scheduled task that is not its own.

    `-Uninstall` removes only the task. The runtime copy, config, state and log stay in place.

    `-WhatIf` performs every read and validation, prints the plan, and changes nothing.

.PARAMETER Uninstall
    Remove the scheduled task registered by this installer.

.PARAMETER GhPath
    Absolute path to the GitHub CLI. Defaults to the `gh` command resolved from PATH.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch]$Uninstall,
    [string]$GhPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The installer prints one JSON line; keep non-ASCII paths intact under Windows PowerShell 5.1.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:TaskName = 'omp-settings-ru-upstream-watch'
$script:WatcherName = 'watch.ps1'
$script:RemoteWatcherPath = 'scripts/maintenance-watch.ps1'
$script:Branch = 'main'
$script:Workflow = 'upstream-watch.yml'
$script:Registry = 'https://registry.npmjs.org'
$script:TaskArguments = '-NoProfile -NonInteractive -File "{0}" -Once'

function Get-WatchRoot {
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if ([string]::IsNullOrWhiteSpace($localAppData)) { throw 'localappdata-unavailable' }
    return [IO.Path]::Combine($localAppData, 'omp-settings-ru', 'maintenance')
}

function Get-InstallerCode {
    param($ErrorRecord)
    $message = ''
    if ($null -ne $ErrorRecord) {
        if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $message = [string]$ErrorRecord.Exception.Message }
        else { $message = [string]$ErrorRecord }
    }
    if ([string]::IsNullOrEmpty($message) -or $message.Length -gt 120) { return 'unexpected-failure' }
    if ($message -match '^[a-z][a-z0-9-]*(:[A-Za-z0-9._/-]+)?$') { return $message }
    return 'unexpected-failure'
}

function Write-InstallerResult {
    param([string]$Decision, [hashtable]$Fields)
    $payload = [ordered]@{ decision = $Decision }
    foreach ($key in @($Fields.Keys | Sort-Object)) {
        $value = $Fields[$key]
        if ($null -ne $value) { $payload[$key] = $value }
    }
    Write-Output (ConvertTo-Json -InputObject $payload -Depth 5 -Compress)
}

function Get-NormalizedText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
    # Line-ending style and the trailing newline of a streamed file are not content changes.
    return $normalized.TrimEnd([char[]]@("`n"))
}

function Get-TextHash {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes((Get-NormalizedText $Text))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-FileTextHash {
    param([string]$Path)
    return Get-TextHash ([IO.File]::ReadAllText($Path))
}

function Resolve-ToolPath {
    param([string]$Explicit, [string]$Name)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw ($Name + '-not-found') }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw ($Name + '-not-found') }
    $source = [string]$command.Source
    if ([string]::IsNullOrWhiteSpace($source)) { throw ($Name + '-not-found') }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ($Name + '-not-found') }
    return (Resolve-Path -LiteralPath $source).Path
}

function Invoke-External {
    param([string]$Gh, [string[]]$GhArguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $merged = @(& $Gh @GhArguments 2>&1)
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

function Get-RepositorySlug {
    param([string]$CheckoutRoot)
    $packagePath = [IO.Path]::Combine($CheckoutRoot, 'package.json')
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'repository-unknown' }
    $package = $null
    try { $package = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($packagePath)) } catch { throw 'repository-unknown' }
    if ($null -eq $package) { throw 'repository-unknown' }
    $repository = $package.PSObject.Properties['repository']
    if ($null -eq $repository -or $null -eq $repository.Value) { throw 'repository-unknown' }
    $url = [string]$repository.Value.url
    if ($url -notmatch 'github\.com[:/]([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(\.git)?$') { throw 'repository-unknown' }
    return ($Matches[1] + '/' + $Matches[2])
}

function Get-RemoteText {
    param([string]$Gh, [string]$Repository, [string]$Path, [string]$Ref)
    $result = Invoke-External -Gh $Gh -GhArguments @('api', '-H', 'Accept:application/vnd.github.raw', ('repos/{0}/contents/{1}?ref={2}' -f $Repository, $Path, $Ref))
    if ($result.Code -ne 0) { return $null }
    return [string]$result.Stdout
}

function Test-AcceptedMain {
    param([string]$Gh, [string]$Repository, [string]$LocalHash)
    $remote = Get-RemoteText -Gh $Gh -Repository $Repository -Path $script:RemoteWatcherPath -Ref $script:Branch
    if ($null -eq $remote) { return $false }
    return ((Get-TextHash $remote) -eq $LocalHash)
}

function Get-PowerShellPath {
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { throw 'powershell-not-found' }
    $path = [IO.Path]::Combine($systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'powershell-not-found' }
    return $path
}

function Get-WatcherArguments {
    param([string]$WatcherPath)
    return ($script:TaskArguments -f $WatcherPath)
}

function Get-BareAccountName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    $parts = $Name.Split('\')
    return $parts[$parts.Length - 1].ToLowerInvariant()
}

function Test-TaskOwnership {
    param($Task, [string]$ExpectedExecute, [string]$ExpectedArguments, [string]$ExpectedUserId)
    if ($null -eq $Task) { return 'absent' }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return 'conflict' }
    $action = $actions[0]
    if ([string]::IsNullOrWhiteSpace([string]$action.Execute)) { return 'conflict' }
    if (-not ([string]$action.Execute).Equals($ExpectedExecute, [StringComparison]::OrdinalIgnoreCase)) { return 'conflict' }
    if (-not ([string]$action.Arguments).Trim().Equals($ExpectedArguments.Trim(), [StringComparison]::OrdinalIgnoreCase)) { return 'conflict' }
    $principal = $Task.Principal
    if ($null -eq $principal) { return 'conflict' }
    if ([string]$principal.LogonType -ne 'Interactive') { return 'conflict' }
    if ([string]$principal.RunLevel -ne 'Limited') { return 'conflict' }
    if ((Get-BareAccountName ([string]$principal.UserId)) -ne (Get-BareAccountName $ExpectedUserId)) { return 'conflict' }
    return 'match'
}

function Get-ExistingTask {
    param([string]$TaskName)
    # Enumerating avoids the locale-dependent "not found" error text of -TaskName: a missing task is
    # indistinguishable from an unreadable store, and that difference decides whether we may
    # register over an existing task. An unreadable store therefore fails the installer.
    try { $tasks = @(Get-ScheduledTask -ErrorAction Stop) }
    catch { throw 'scheduled-tasks-unavailable' }
    foreach ($task in $tasks) {
        if ([string]$task.TaskName -eq $TaskName) { return $task }
    }
    return $null
}

function Invoke-Install {
    param([string]$GhPath, [bool]$WhatIf)
    $checkoutRoot = Split-Path -Parent $PSScriptRoot
    $watcherSource = [IO.Path]::Combine($PSScriptRoot, 'maintenance-watch.ps1')
    if (-not (Test-Path -LiteralPath $watcherSource -PathType Leaf)) { throw 'watcher-source-missing' }
    $repository = Get-RepositorySlug -CheckoutRoot $checkoutRoot
    $gh = Resolve-ToolPath -Explicit $GhPath -Name 'gh'
    $root = Get-WatchRoot
    $watcherPath = [IO.Path]::Combine($root, $script:WatcherName)
    $configPath = [IO.Path]::Combine($root, 'config.json')
    $powershellPath = Get-PowerShellPath
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ([string]::IsNullOrWhiteSpace($currentUser)) { throw 'user-unavailable' }

    $bun = $null
    try { $bun = Resolve-ToolPath -Explicit '' -Name 'bun' } catch { $bun = '' }

    $auth = Invoke-External -Gh $gh -GhArguments @('auth', 'status')
    if ($auth.Code -ne 0) { throw 'gh-auth-failed' }

    $localHash = Get-FileTextHash $watcherSource
    if (-not (Test-AcceptedMain -Gh $gh -Repository $repository -LocalHash $localHash)) { throw 'main-not-accepted' }

    $arguments = Get-WatcherArguments -WatcherPath $watcherPath
    $existing = Get-ExistingTask -TaskName $script:TaskName
    $ownership = Test-TaskOwnership -Task $existing -ExpectedExecute $powershellPath -ExpectedArguments $arguments -ExpectedUserId $currentUser
    if ($ownership -eq 'conflict') { throw 'scheduled-task-ownership-conflict' }

    $plan = @{
        taskName = $script:TaskName
        root = $root
        watcher = $watcherPath
        config = $configPath
        repository = $repository
        gh = $gh
        bun = $bun
        powershell = $powershellPath
        user = $currentUser
        arguments = $arguments
        ownership = $ownership
        watcherSha256 = $localHash
    }

    if ($WhatIf) {
        Write-InstallerResult -Decision 'install-plan' -Fields $plan
        return
    }

    if ($PSCmdlet.ShouldProcess($script:TaskName, 'Install maintenance watcher task')) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
        Copy-Item -LiteralPath $watcherSource -Destination $watcherPath -Force
        if ((Get-FileTextHash $watcherPath) -ne $localHash) { throw 'watcher-copy-mismatch' }

        $config = [ordered]@{
            schemaVersion = 1
            repository = $repository
            branch = $script:Branch
            workflow = $script:Workflow
            registry = $script:Registry
            gh = $gh
        }
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($configPath, ((ConvertTo-Json -InputObject $config -Depth 4) + [Environment]::NewLine), $encoding)

        $selfTest = Invoke-External -Gh $powershellPath -GhArguments @('-NoProfile', '-NonInteractive', '-File', $watcherPath, '-Status')
        if ($selfTest.Code -ne 0) {
            # A blocked local script is a prerequisite of this machine, not something to bypass with
            # a global ExecutionPolicy change; name it precisely and stop.
            if ($selfTest.Stderr -match 'execution policy|ExecutionPolicy|UnauthorizedAccess') { throw 'execution-policy-blocked' }
            throw 'watcher-runtime-unavailable'
        }
        if (-not $selfTest.Stdout.Contains('"config":true')) { throw 'watcher-config-unreadable' }
        if (-not $selfTest.Stdout.Contains('"watcher":true')) { throw 'watcher-runtime-unavailable' }

        $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Hours 1)
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun:$false
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

        $registered = Get-ExistingTask -TaskName $script:TaskName
        if ($null -eq $registered) { throw 'task-registration-failed' }
        $verified = Test-TaskOwnership -Task $registered -ExpectedExecute $powershellPath -ExpectedArguments $arguments -ExpectedUserId $currentUser
        if ($verified -ne 'match') { throw 'task-registration-failed' }

        $plan['taskState'] = [string]$registered.State
        Write-InstallerResult -Decision 'installed' -Fields $plan
        return
    }
}

function Invoke-Uninstall {
    param([bool]$WhatIf)
    $root = Get-WatchRoot
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $watcherPath = [IO.Path]::Combine($root, $script:WatcherName)
    $powershellPath = Get-PowerShellPath
    $existing = Get-ExistingTask -TaskName $script:TaskName
    if ($null -eq $existing) {
        Write-InstallerResult -Decision 'not-installed' -Fields @{ taskName = $script:TaskName; root = $root }
        return
    }
    $arguments = Get-WatcherArguments -WatcherPath $watcherPath
    $ownership = Test-TaskOwnership -Task $existing -ExpectedExecute $powershellPath -ExpectedArguments $arguments -ExpectedUserId $currentUser
    if ($ownership -ne 'match') { throw 'scheduled-task-ownership-conflict' }
    if ($WhatIf) {
        Write-InstallerResult -Decision 'uninstall-plan' -Fields @{ taskName = $script:TaskName; root = $root; ownership = $ownership }
        return
    }
    if ($PSCmdlet.ShouldProcess($script:TaskName, 'Uninstall maintenance watcher task')) {
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
        if ($null -ne (Get-ExistingTask -TaskName $script:TaskName)) { throw 'task-uninstall-failed' }
        Write-InstallerResult -Decision 'uninstalled' -Fields @{ taskName = $script:TaskName; root = $root; retained = @('watch.ps1', 'config.json', 'state.json', 'watch.log') }
    }
}

function Invoke-Main {
    $whatIf = [bool]$WhatIfPreference
    try {
        if ($Uninstall) { Invoke-Uninstall -WhatIf $whatIf }
        else { Invoke-Install -GhPath $GhPath -WhatIf $whatIf }
        exit 0
    }
    catch {
        $code = Get-InstallerCode $_
        Write-InstallerResult -Decision $code -Fields @{ taskName = $script:TaskName }
        exit 1
    }
}

# Dot-sourcing exposes the decision helpers without installing anything.
if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
