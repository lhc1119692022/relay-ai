param(
  [int]$ParentPid,
  [string]$ProfileDir
)
$ErrorActionPreference = 'SilentlyContinue'
$profileDir = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
$cliPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\cli.js'))

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
  return ($line.IndexOf($cliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) `
    -and ($line -match '(?i)(?:^|\s)(?:antigravity|agy|antigravity-ide)(?:\s|$)')
}

function Stop-ManagedProcessTree([int]$processId) {
  if ($processId -le 0 -or $processId -eq $PID) { return }
  & taskkill.exe /PID $processId /T /F *> $null
}

function Get-ManagedSnapshot {
  try {
    try { $all = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
    catch { $all = @(Get-WmiObject Win32_Process -ErrorAction Stop) }
    return [PSCustomObject]@{
      Success = $true
      Profile = @($all | Where-Object { Test-ManagedProfileProcess $_ })
      Relay = @($all | Where-Object { Test-ManagedRelayProcess $_ })
    }
  } catch {
    # WMI can be unavailable for a few seconds during login/resume. Returning
    # Success=false is important: an empty result must not be mistaken for a
    # clean shutdown while the managed processes are still alive.
    return [PSCustomObject]@{ Success = $false; Profile = @(); Relay = @() }
  }
}

while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 2
}

# Retry both the query and the kill for a bounded period. This handles the
# short WMI outage that can occur when a terminal closes during Windows login.
# Do not exit merely because one enumeration returned no rows.
$deadline = (Get-Date).AddSeconds(30)
do {
  $snapshot = Get-ManagedSnapshot
  if (-not $snapshot.Success) {
    Start-Sleep -Milliseconds 500
    continue
  }

  foreach ($process in @($snapshot.Profile + $snapshot.Relay)) {
    Stop-ManagedProcessTree ([int]$process.ProcessId)
  }

  if ($snapshot.Profile.Count -eq 0 -and $snapshot.Relay.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
