$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$profileDir = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.relay-ai\antigravity\app-profile')).TrimEnd('\')
$cli = [IO.Path]::GetFullPath((Join-Path $root 'dist\cli.js'))
$watchdogScript = Join-Path $PSScriptRoot 'antigravity-relay-watchdog.ps1'
$launcherPath = [IO.Path]::GetFullPath($PSCommandPath)
$localProxyStartupWaitSeconds = 90
$startupProcessDeadlineSeconds = 180
$missingProcessGraceSeconds = 20
$processInventoryStartupWaitSeconds = 60

function Convert-WinInetProxyToUrl([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  $selected = $value.Trim()
  $mapped = @{}
  foreach ($part in $selected.Split(';')) {
    if ($part -match '^\s*([^=]+)=(.+)$') {
      $mapped[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
    }
  }
  if ($mapped.ContainsKey('https')) { $selected = $mapped['https'] }
  elseif ($mapped.ContainsKey('http')) { $selected = $mapped['http'] }
  elseif ($mapped.ContainsKey('proxy')) { $selected = $mapped['proxy'] }
  if ($selected -notmatch '^[a-z][a-z\d+.-]*://') { $selected = "http://$selected" }
  return $selected
}

function Add-ProxyBypassHosts([string]$value) {
  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $entries = @($value -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  foreach ($bypassHost in @('localhost', '127.0.0.1', '::1')) {
    if (-not ($entries | Where-Object { $_ -ieq $bypassHost })) { $entries += $bypassHost }
  }
  return ($entries -join ',')
}

function Test-LocalTcpPort([string]$targetHost, [int]$port) {
  if ([string]::IsNullOrWhiteSpace($targetHost) -or $port -le 0) { return $false }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($targetHost, $port)
    if (-not $task.Wait(750)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-WindowsProcessRows {
  param(
    [string]$Filter,
    [int]$TimeoutSeconds = 10
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      if ([string]::IsNullOrWhiteSpace($Filter)) {
        try { return @(Get-CimInstance Win32_Process -ErrorAction Stop) }
        catch { return @(Get-WmiObject Win32_Process -ErrorAction Stop) }
      }
      try { return @(Get-CimInstance Win32_Process -Filter $Filter -ErrorAction Stop) }
      catch { return @(Get-WmiObject Win32_Process -Filter $Filter -ErrorAction Stop) }
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  throw "Windows process inventory is not available after $TimeoutSeconds seconds: $($lastError.Exception.Message)"
}

# Explorer does not reliably copy WinINet proxy settings into the environment
# inherited by a Start Menu shortcut. Antigravity's Go language server uses
# these variables for its Google auth/background requests, so fill them from
# the current user's settings before Relay starts.
$winInet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
$configuredProxy = $null
if ($winInet -and [int]$winInet.ProxyEnable -ne 0) {
  $configuredProxy = Convert-WinInetProxyToUrl ([string]$winInet.ProxyServer)
}
if ($configuredProxy) {
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      [Environment]::SetEnvironmentVariable($name, $configuredProxy, 'Process')
    }
  }
  $bypass = Add-ProxyBypassHosts ([string]$winInet.ProxyOverride)
  foreach ($name in @('NO_PROXY', 'no_proxy')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      [Environment]::SetEnvironmentVariable($name, $bypass, 'Process')
    }
  }

  try {
    $proxyUri = [Uri]$configuredProxy
    if ($proxyUri.Host -in @('127.0.0.1', 'localhost', '::1')) {
      Write-Host "Waiting for configured local proxy $($proxyUri.Host):$($proxyUri.Port)..." -ForegroundColor DarkCyan
      $proxyDeadline = (Get-Date).AddSeconds($localProxyStartupWaitSeconds)
      while (-not (Test-LocalTcpPort $proxyUri.Host $proxyUri.Port) -and (Get-Date) -lt $proxyDeadline) {
        Start-Sleep -Milliseconds 500
      }
      if (Test-LocalTcpPort $proxyUri.Host $proxyUri.Port) {
        Write-Host 'Local proxy is reachable.' -ForegroundColor DarkCyan
      } else {
        Write-Host 'Local proxy is not reachable yet; continuing so the language server can retry.' -ForegroundColor Yellow
      }
    }
  } catch {
    Write-Host 'A Windows proxy is configured; its endpoint could not be parsed for a readiness check.' -ForegroundColor Yellow
  }
}

# Explorer-launched shortcuts can inherit a stale PATH after Node is installed
# or updated. Prefer the normal command lookup, then use common per-machine and
# per-user install locations so the terminal shows a useful error only when
# Node is genuinely unavailable.
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $node) {
  $nodeCandidates = @(
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Programs\node\node.exe')
  )
  $node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $node) {
  Write-Error 'Node.js was not found. Install Node.js or add node.exe to PATH, then reopen this shortcut.'
  exit 127
}
if (-not (Test-Path -LiteralPath $cli)) {
  Write-Error "Relay CLI bundle not found: $cli. Run npm run build in the relay-ai project first."
  exit 1
}

# Protect this script and the shell chain that invoked it.  A shortcut may be
# launched while an older launcher is still closing; only that older launcher's
# exact process should be terminated, never the current terminal host.
$protectedPids = [System.Collections.Generic.HashSet[int]]::new()
[void]$protectedPids.Add([int]$PID)
$startupProcesses = try {
  @(Get-WindowsProcessRows -TimeoutSeconds $processInventoryStartupWaitSeconds)
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
$processById = @{}
foreach ($process in $startupProcesses) {
  $processById[[int]$process.ProcessId] = $process
}
$cursor = $processById[[int]$PID]
while ($cursor) {
  [void]$protectedPids.Add([int]$cursor.ProcessId)
  $parentId = [int]$cursor.ParentProcessId
  if ($parentId -le 0 -or $parentId -eq $cursor.ProcessId) { break }
  $cursor = $processById[$parentId]
}

function Test-ManagedProfileProcess($process) {
  $name = [IO.Path]::GetFileName([string]$process.Name)
  if ($name -notin @('Antigravity.exe', 'language_server.exe')) { return $false }
  $line = ([string]$process.CommandLine).Replace('/', '\').Replace('"', '')
  if ([string]::IsNullOrWhiteSpace($line)) { return $false }
  return $line.IndexOf(
    "--user-data-dir=$profileDir", [StringComparison]::OrdinalIgnoreCase
  ) -ge 0
}

function Test-ManagedRelayProcess($process) {
  $name = [IO.Path]::GetFileName([string]$process.Name)
  if ($name -notin @('node.exe', 'node')) { return $false }
  $line = ([string]$process.CommandLine).Replace('/', '\').Replace('"', '')
  if ([string]::IsNullOrWhiteSpace($line)) { return $false }
  $cliMatch = $line.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $commandMatch = $line -match '(?i)(?:^|\s)(?:antigravity|agy|antigravity-ide)(?:\s|$)'
  return $cliMatch -and $commandMatch
}

function Test-ManagedLauncherProcess($process) {
  $name = [IO.Path]::GetFileName([string]$process.Name)
  if ($name -notin @('pwsh.exe', 'powershell.exe')) { return $false }
  $processId = [int]$process.ProcessId
  if ($protectedPids.Contains($processId)) { return $false }
  $line = ([string]$process.CommandLine).Replace('/', '\').Replace('"', '')
  if ([string]::IsNullOrWhiteSpace($line)) { return $false }
  # A parent `pwsh -Command ... -File ...` wrapper also contains this path;
  # require a direct -File invocation so it is not mistaken for an old tab.
  if ($line -match '(?i)(?:^|\s)-(?:command|c)\s') { return $false }
  return $line.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -and $line -match '(?i)(?:^|\s)-file\s'
}

function Test-ManagedWatchdogProcess($process) {
  $name = [IO.Path]::GetFileName([string]$process.Name)
  if ($name -notin @('pwsh.exe', 'powershell.exe')) { return $false }
  $processId = [int]$process.ProcessId
  if ($protectedPids.Contains($processId)) { return $false }
  $line = ([string]$process.CommandLine).Replace('/', '\').Replace('"', '')
  if ([string]::IsNullOrWhiteSpace($line)) { return $false }
  return $line.IndexOf($watchdogScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -and $line.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-ManagedProcessTree([int]$processId) {
  if ($processId -le 0 -or $processId -eq $PID) { return }
  # /T is important here: Antigravity's language_server.exe often does not
  # repeat --user-data-dir in its own command line, but it is still a child of
  # the managed Antigravity process.
  & taskkill.exe /PID $processId /T /F *> $null
}

function Get-ManagedProcesses {
  try {
    return @(Get-WindowsProcessRows -TimeoutSeconds 5 | Where-Object {
      $_.ProcessId -ne $PID -and (Test-ManagedProfileProcess $_ -or Test-ManagedRelayProcess $_)
    })
  } catch {
    return $null
  }
}

function Wait-ManagedProcessesStopped([int]$timeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    $remaining = Get-ManagedProcesses
    if ($null -eq $remaining) {
      Start-Sleep -Milliseconds 500
      continue
    }
    if ($remaining.Count -eq 0) { return $true }
    foreach ($process in $remaining) {
      Stop-ManagedProcessTree ([int]$process.ProcessId)
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

# Stop an older watchdog before its launcher. Otherwise killing the launcher
# wakes that watchdog and it can mistake this launch's new profile process for
# residue from the old session.
$oldWatchdogs = @($startupProcesses | Where-Object {
  Test-ManagedWatchdogProcess $_
})
foreach ($process in $oldWatchdogs) {
  Write-Host "Stopping old Relay watchdog $($process.ProcessId)..." -ForegroundColor Yellow
  Stop-ManagedProcessTree ([int]$process.ProcessId)
}
if ($oldWatchdogs) { Start-Sleep -Milliseconds 400 }

# Stop older copies of this exact launcher next. Their `finally` blocks can
# otherwise race the new launch and kill the newly-created profile process.
$cleanupProcesses = try { @(Get-WindowsProcessRows -TimeoutSeconds 15) } catch { @() }
$oldLaunchers = @($cleanupProcesses | Where-Object {
  Test-ManagedLauncherProcess $_
})
foreach ($process in $oldLaunchers) {
  Write-Host "Stopping old Relay launcher $($process.ProcessId)..." -ForegroundColor Yellow
  Stop-ManagedProcessTree ([int]$process.ProcessId)
}
if ($oldLaunchers) { Start-Sleep -Milliseconds 800 }

# Only stop the exact managed GUI/profile processes and Relay's Node CLI.
# Do not use a broad "relay-ai ... antigravity" wildcard here: it also matches
# this PowerShell script, watchdogs, and unrelated diagnostic profiles.
$cleanupProcesses = try { @(Get-WindowsProcessRows -TimeoutSeconds 15) } catch { @() }
$old = @($cleanupProcesses | Where-Object {
  $_.ProcessId -ne $PID -and (Test-ManagedProfileProcess $_ -or Test-ManagedRelayProcess $_)
})
foreach ($process in $old) {
  Write-Host "Stopping old Relay process $($process.ProcessId) ($($process.Name))..." -ForegroundColor Yellow
  Stop-ManagedProcessTree ([int]$process.ProcessId)
}
if ($old) {
  if (-not (Wait-ManagedProcessesStopped)) {
    Write-Host 'Some old Relay processes did not exit within 15 seconds; continuing with a fresh launch.' -ForegroundColor Yellow
  }
}

$watchdog = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  # Start-Process joins ArgumentList into one command line, so quote this
  # path explicitly; the repository directory contains a space.
  '-File', "`"$watchdogScript`"",
  '-ParentPid', $PID, '-ProfileDir', $profileDir
) -WindowStyle Hidden -PassThru

Write-Host 'Starting Antigravity through Relay AI...' -ForegroundColor Cyan
$relay = Start-Process -FilePath $node -ArgumentList @(
  "`"$cli`"", 'antigravity', '--provider', 'custom-ezai', '--model', 'gemini-3.8-flash-high', '--trace'
) -WorkingDirectory $root -NoNewWindow -PassThru

$exitCode = 0
try {
  # Wait for the managed GUI process to appear or for Relay to fail early.
  $deadline = (Get-Date).AddSeconds($startupProcessDeadlineSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $agyRows = try { @(Get-WindowsProcessRows -Filter "Name='Antigravity.exe'" -TimeoutSeconds 2) } catch { $null }
    $agy = if ($null -eq $agyRows) { $null } else { @($agyRows | Where-Object { Test-ManagedProfileProcess $_ }) }
  } while (($null -eq $agy -or $agy.Count -eq 0) -and (Get-Date) -lt $deadline -and -not $relay.HasExited)
  $seenAgy = $null -ne $agy -and $agy.Count -gt 0

  # A failed cold start is recovered inside relay-ai by replacing the managed
  # Antigravity process. Keep the terminal alive across that short gap, while
  # still treating a user-closed app as the end of this session.
  $missingSince = $null
  $missingNoticeShown = $false
  while (-not $relay.HasExited) {
    Start-Sleep -Seconds 2
    $agyRows = try { @(Get-WindowsProcessRows -Filter "Name='Antigravity.exe'" -TimeoutSeconds 2) } catch { $null }
    if ($null -eq $agyRows) { continue }
    $agy = @($agyRows | Where-Object { Test-ManagedProfileProcess $_ })
    if ($agy.Count -gt 0) {
      $seenAgy = $true
      $missingSince = $null
      continue
    }
    # Relay owns startup recovery. Do not interpret "not launched yet" as the
    # user closing the app while provider discovery/readiness is still active.
    if (-not $seenAgy) { continue }
    if ($null -eq $missingSince) {
      $missingSince = Get-Date
      if (-not $missingNoticeShown) {
        Write-Host "Antigravity process temporarily disappeared; waiting up to $missingProcessGraceSeconds seconds for an Electron restart..." -ForegroundColor Yellow
        $missingNoticeShown = $true
      }
      continue
    }
    if (((Get-Date) - $missingSince).TotalSeconds -ge $missingProcessGraceSeconds) {
      Write-Host 'Antigravity has closed. Stopping the Relay gateway...' -ForegroundColor DarkCyan
      Stop-ManagedProcessTree ([int]$relay.Id)
      break
    }
  }
}
finally {
  # Closing Antigravity or this terminal must not leave a Relay gateway behind.
  # Capture Relay's status before cleanup: the final taskkill command otherwise
  # becomes PowerShell's process exit status and hides startup failures.
  if ($relay -and $relay.HasExited) {
    $exitCode = $relay.ExitCode
  }
  elseif ($relay) {
    Stop-ManagedProcessTree ([int]$relay.Id)
    try { $relay.WaitForExit(5000) } catch { }
    if ($relay.HasExited) { $exitCode = $relay.ExitCode }
  }
  [void](Wait-ManagedProcessesStopped)
  if ($watchdog -and -not $watchdog.HasExited) {
    Stop-ManagedProcessTree ([int]$watchdog.Id)
  }
}

exit ([int]$exitCode)
