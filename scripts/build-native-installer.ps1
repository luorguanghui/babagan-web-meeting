#Requires -Version 7.0
param([string] $Destination = 'output/native-installer')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$installerRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $Destination))
$allowedOutput = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output')) + [IO.Path]::DirectorySeparatorChar
if (-not $installerRoot.StartsWith($allowedOutput, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer output must be inside this repository output directory.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework compiler is required on the build machine.' }
New-Item -ItemType Directory -Path $installerRoot -Force | Out-Null
$payloadRoot = Join-Path $installerRoot ('payload-' + [guid]::NewGuid().ToString('N'))
$relativePayload = [IO.Path]::GetRelativePath((Join-Path $projectRoot 'output'), $payloadRoot)
& node (Join-Path $PSScriptRoot 'package-native-capture.mjs') $relativePayload
if ($LASTEXITCODE -ne 0) { throw 'Native helper bundle failed.' }
$windowsSource = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'apps/native-capture/windows')).Path
$versionMatch = [regex]::Match((Get-Content -LiteralPath (Join-Path $windowsSource 'Package.cs') -Raw), 'Version = "([0-9.]+)"')
if (-not $versionMatch.Success) { throw 'Missing native version' }
$nativeVersion = $versionMatch.Groups[1].Value
$common = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', "/win32icon:$(Join-Path $windowsSource 'assets/babagan.ico')", "/win32manifest:$(Join-Path $windowsSource 'app.manifest')", '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Net.Http.dll', '/reference:Microsoft.CSharp.dll')
& $compiler @common "/out:$(Join-Path $payloadRoot 'BabaganLauncher.exe')" (Join-Path $windowsSource 'AssemblyInfo.cs') (Join-Path $windowsSource 'Package.cs') (Join-Path $windowsSource 'RuntimeDependencies.cs') (Join-Path $windowsSource 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
$archive = Join-Path $installerRoot ('payload-' + [guid]::NewGuid().ToString('N') + '.zip')
[IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
$setup = Join-Path $installerRoot 'BabaganSetup.exe'
& $compiler @common "/out:$setup" "/resource:$archive,payload.zip" (Join-Path $windowsSource 'AssemblyInfo.cs') (Join-Path $windowsSource 'Package.cs') (Join-Path $windowsSource 'RuntimeDependencies.cs') (Join-Path $windowsSource 'Installer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
$manifest = @{ version = $nativeVersion; file = 'BabaganSetup.exe'; sha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $setup).Length; source = (& git -C $projectRoot rev-parse HEAD).Trim(); dirty = [bool](& git -C $projectRoot status --porcelain); runtimeDownload = 'Pinned Node.js 24.15.0 and FFmpeg 9.0.2 from meet.babagan.cloud'; architecture = 'Windows x64' }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installerRoot 'release.json') -Encoding utf8
Write-Output "Installer built: $setup"
