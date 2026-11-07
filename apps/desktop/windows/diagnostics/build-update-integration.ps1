#Requires -Version 7.0
param(
  [string] $Destination = 'output/windows-update-diagnostic',
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')] [string] $BaselineVersion = '0.1.0',
  [switch] $Run,
  [string] $BaselinePayload,
  [string] $TestRoot,
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')] [string] $TargetVersion = '0.1.1',
  [long] $TargetSequence = 2
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
$output = [IO.Path]::GetFullPath((Join-Path $repo 'output'))
$destinationRoot = [IO.Path]::GetFullPath((Join-Path $repo $Destination))
if (-not $destinationRoot.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic build must remain under workspace output.' }
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$source = Join-Path $repo 'apps/desktop/windows'
$native = Join-Path $repo 'apps/native-capture/windows'
$key = Join-Path $repo 'scripts/client-update-public-key.json'
if (-not (Test-Path -LiteralPath $key)) { throw 'Pinned public update key is required.' }
$package = Get-Content -LiteralPath (Join-Path $source 'Package.cs') -Raw
$pattern = 'internal const string Version = "[0-9.]+";'
if (-not [regex]::IsMatch($package, $pattern)) { throw 'Cannot locate baseline version constant.' }
$package = [regex]::Replace($package, $pattern, ('internal const string Version = "' + $BaselineVersion + '";'))
$packagePath = Join-Path $destinationRoot 'Package.baseline.cs'
[IO.File]::WriteAllText($packagePath, $package, [Text.UTF8Encoding]::new($false))
$paths = 'namespace Babagan { internal static class DiagnosticPaths { internal const string OutputRoot = @"' + $output.Replace('"','""') + '"; } }'
$pathsFile = Join-Path $destinationRoot 'DiagnosticPaths.cs'
[IO.File]::WriteAllText($pathsFile, $paths, [Text.UTF8Encoding]::new($false))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$exe = Join-Path $destinationRoot 'UpdateIntegration.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /utf8output /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Net.Http.dll "/resource:$key,update-key.json" "/out:$exe" $packagePath $pathsFile (Join-Path $source 'Release.cs') (Join-Path $source 'Downloads.cs') (Join-Path $source 'Updater.cs') (Join-Path $native 'RuntimeDependencies.cs') (Join-Path $PSScriptRoot 'UpdateIntegration.cs')
if ($LASTEXITCODE -ne 0) { throw 'Update integration harness build failed.' }
Write-Output "Prepared real-feed diagnostic: $exe (baseline $BaselineVersion). No update test has run yet."
if ($Run) {
  if (-not $BaselinePayload) { throw '-BaselinePayload must be an installed version directory containing runtime.json.' }
  if (-not $TestRoot) { $TestRoot = Join-Path $output ('windows-update-acceptance-' + [guid]::NewGuid().ToString('N')) }
  & $exe ([IO.Path]::GetFullPath($TestRoot)) ([IO.Path]::GetFullPath($BaselinePayload)) $TargetVersion $TargetSequence
  if ($LASTEXITCODE -ne 0) { throw 'Real-feed automatic update acceptance failed.' }
}
