#Requires -Version 7.0
param(
  [string] $Ffmpeg = $env:BABAGAN_FFMPEG,
  [string] $Edge,
  [string] $Origin = 'https://meet.babagan.cloud',
  [switch] $NoOpen,
  [ValidateRange(1, 120)] [int] $StartupTimeoutSeconds = 15,
  [ValidateRange(100, 2147483647)] [int] $IdleTimeoutMs = 1800000
)

$ErrorActionPreference = 'Stop'
$meetingRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cliPath = Join-Path $meetingRoot 'apps/native-capture/dist/cli.js'
if (-not (Test-Path -LiteralPath $cliPath)) {
  Push-Location -LiteralPath $meetingRoot
  try {
    & pnpm --filter '@meeting/native-capture' build
    if ($LASTEXITCODE -ne 0) { throw 'Native capture build failed. Run pnpm install, then build again.' }
  } finally { Pop-Location }
}

$nodePath = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$statusDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'BabaganNativeCapture'
[System.IO.Directory]::CreateDirectory($statusDirectory) > $null
$statusPath = Join-Path $statusDirectory (([guid]::NewGuid().ToString('N')) + '.json')
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodePath
$startInfo.WorkingDirectory = $meetingRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.ArgumentList.Add($cliPath)
$startInfo.ArgumentList.Add('--status-file')
$startInfo.ArgumentList.Add($statusPath)
$startInfo.ArgumentList.Add('--origin')
$startInfo.ArgumentList.Add($Origin)
$startInfo.ArgumentList.Add('--idle-timeout-ms')
$startInfo.ArgumentList.Add([string]$IdleTimeoutMs)
if ($Ffmpeg) {
  $startInfo.ArgumentList.Add('--ffmpeg')
  $startInfo.ArgumentList.Add($Ffmpeg)
}
if ($Edge) {
  $startInfo.ArgumentList.Add('--edge')
  $startInfo.ArgumentList.Add($Edge)
}
if ($NoOpen) { $startInfo.ArgumentList.Add('--no-open') }
$helperProcess = $null
try {
  $helperProcess = [System.Diagnostics.Process]::Start($startInfo)
  $stdoutDrain = $helperProcess.StandardOutput.ReadToEndAsync()
  $stderrDrain = $helperProcess.StandardError.ReadToEndAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $status = $null
    if (Test-Path -LiteralPath $statusPath) {
      if ((Get-Item -LiteralPath $statusPath).Length -gt 4096) { throw 'Native helper returned an oversized startup status.' }
      try { $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json -ErrorAction Stop }
      catch { $status = $null } # A tiny status file may still be completing its first write.
    }
    if ($status) {
      if ($status.version -ne 1 -or $status.pid -ne $helperProcess.Id) { throw 'Native helper returned an invalid startup status.' }
      if ($status.state -eq 'error') { throw "Native helper startup failed: $($status.message)" }
      if ($status.state -ne 'ready' -or $status.origin -ne $Origin -or $status.port -lt 1 -or $status.port -gt 65535) {
        throw 'Native helper returned an invalid readiness status.'
      }
      if ($helperProcess.HasExited) { throw 'Native helper exited before startup completed.' }
      Write-Host "Native meeting helper ready (PID $($helperProcess.Id), 127.0.0.1:$($status.port)). It exits after its idle timeout."
      $ready = $true
      break
    }
    if ($helperProcess.HasExited) { throw "Native helper exited before reporting readiness (exit code $($helperProcess.ExitCode)). Run the CLI in the foreground for diagnostics." }
    Start-Sleep -Milliseconds 50
  }
  if (-not $ready) { throw "Native helper startup timed out after $StartupTimeoutSeconds seconds. Check FFmpeg and Edge, then retry." }
} catch {
  if ($helperProcess -and -not $helperProcess.HasExited) {
    $helperProcess.Kill($true) # Only this launch attempt and its own descendants.
    $helperProcess.WaitForExit(5000) > $null
  }
  throw
} finally {
  Remove-Item -LiteralPath $statusPath -ErrorAction SilentlyContinue
  if ($helperProcess) { $helperProcess.Dispose() }
}
