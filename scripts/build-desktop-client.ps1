#Requires -Version 7.0
param([string] $Destination = 'output/desktop-client', [long] $Sequence = 1, [switch] $SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $Destination))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output')) + [IO.Path]::DirectorySeparatorChar
if (-not $buildRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop output must be inside the repository output directory.' }
if ($Sequence -lt 1 -or $Sequence -gt 9007199254740991) { throw 'Invalid release sequence.' }
$source = Join-Path $projectRoot 'apps/desktop/windows'
$native = Join-Path $projectRoot 'apps/native-capture/windows'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework compiler is required.' }
$key = Join-Path $PSScriptRoot 'client-update-public-key.json'
if (-not (Test-Path -LiteralPath $key)) { throw 'The pinned public update key is required.' }
$keyInfo = Get-Content -LiteralPath $key -Raw | ConvertFrom-Json
if ($keyInfo.schema -ne 1 -or $keyInfo.algorithm -ne 'RS256' -or -not $keyInfo.modulusBase64 -or -not $keyInfo.exponentBase64) { throw 'Invalid update public key.' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$cache = Join-Path $projectRoot 'output/desktop-build-cache'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$sdkVersion = '1.0.4314.35'
$sdkHash = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$sdkArchive = Join-Path $cache "webview2-$sdkVersion.nupkg"
if (-not (Test-Path -LiteralPath $sdkArchive)) { Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $sdkArchive }
if ((Get-FileHash -LiteralPath $sdkArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkHash) { throw 'WebView2 SDK hash mismatch.' }
$sdk = Join-Path $cache "webview2-$sdkVersion"
if (-not (Test-Path -LiteralPath $sdk)) { [IO.Compression.ZipFile]::ExtractToDirectory($sdkArchive, $sdk) }
$payload = Join-Path $buildRoot ('payload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $payload -Force | Out-Null
foreach ($file in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) { Copy-Item -LiteralPath (Join-Path $sdk "lib/net462/$file") -Destination $payload }
Copy-Item -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $payload
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $payload 'LICENSE-WebView2.txt')
Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $payload 'NOTICE-WebView2.txt')
$bundler = Join-Path $buildRoot 'bundle-helper.mjs'
@'
import { createRequire } from 'node:module';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2], output = process.argv[3];
const require = createRequire(resolve(root, 'apps/web/package.json'));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
await mkdir(resolve(output, 'apps/native-capture/dist'), { recursive: true });
await build({ entryPoints: [resolve(root, 'apps/native-capture/src/desktop-host.ts')], outfile: resolve(output, 'apps/native-capture/dist/desktop-host.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: 'warning' });
await writeFile(resolve(output, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: '>=24 <25' } }));
await copyFile(resolve(root, 'apps/native-capture/node_modules/ws/LICENSE'), resolve(output, 'LICENSE-ws.txt'));
await copyFile(resolve(root, 'packages/contracts/node_modules/@sinclair/typebox/license'), resolve(output, 'LICENSE-typebox.txt'));
await writeFile(resolve(output, 'THIRD-PARTY-NOTICES.txt'), 'Microsoft WebView2 SDK: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35\nMicrosoft WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/\nNode.js and FFmpeg are downloaded from pinned, unmodified upstream archives; licenses and source metadata: https://meet.babagan.cloud/downloads/runtime/sources.json\nFFmpeg essentials build is GPLv3; exact source and build configuration are published with the runtime mirror.\n');
'@ | Set-Content -LiteralPath $bundler -Encoding utf8
& node $bundler $projectRoot $payload
if ($LASTEXITCODE -ne 0) { throw 'Desktop helper build failed.' }
$versionMatch = [regex]::Match((Get-Content -LiteralPath (Join-Path $source 'Package.cs') -Raw), 'Version = "([0-9.]+)"')
$version = $versionMatch.Groups[1].Value
if (-not $version) { throw 'Missing desktop version.' }
@{ version = $version; sequence = $Sequence } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'release.json') -Encoding utf8
$icon = Join-Path $source 'assets/babagan.ico'
if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path $native 'assets/babagan.ico' }
$options = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', "/win32icon:$icon", "/win32manifest:$(Join-Path $native 'app.manifest')", '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Net.Http.dll', '/reference:Microsoft.CSharp.dll')
$minimal = @((Join-Path $source 'AssemblyInfo.cs'), (Join-Path $source 'Package.cs'), (Join-Path $source 'Release.cs'))
$common = @($minimal) + @((Join-Path $native 'RuntimeDependencies.cs'), (Join-Path $source 'Downloads.cs'), (Join-Path $source 'Updater.cs'))
& $compiler @options "/out:$(Join-Path $payload 'Babagan.exe')" @minimal (Join-Path $source 'Bootstrap.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop bootstrap build failed.' }
& $compiler @options "/out:$(Join-Path $payload 'Babagan.Client.exe')" "/reference:$(Join-Path $payload 'Microsoft.Web.WebView2.Core.dll')" "/reference:$(Join-Path $payload 'Microsoft.Web.WebView2.WinForms.dll')" "/resource:$key,update-key.json" "/resource:$(Join-Path $source 'runtime-artifacts.json'),webview-runtime.json" @common (Join-Path $source 'Helper.cs') (Join-Path $source 'Client.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop client build failed.' }
if (-not $SkipTests) {
  $test = Join-Path $buildRoot 'UpdaterTests.exe'
  & $compiler /nologo /target:exe /platform:x64 /utf8output /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Net.Http.dll "/out:$test" @common (Join-Path $source 'UpdaterTests.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Updater tests compilation failed.' }
  & $test (Join-Path $buildRoot ('test-' + [guid]::NewGuid().ToString('N')))
  if ($LASTEXITCODE -ne 0) { throw 'Updater tests failed.' }
}
$zip = Join-Path $buildRoot 'client.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
[IO.Compression.ZipFile]::CreateFromDirectory($payload, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$installer = Join-Path $buildRoot "BabaganClientSetup-$version.exe"
& $compiler @options "/out:$installer" "/resource:$zip,client.zip" "/resource:$(Join-Path $source 'runtime-artifacts.json'),webview-runtime.json" @common (Join-Path $source 'Installer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop installer build failed.' }
$manifest = @{ schema = 1; product = 'babagan-client'; platform = 'windows'; channel = 'stable'; version = $version; sequence = $Sequence; source = (& git -C $projectRoot rev-parse HEAD).Trim(); dirty = [bool](& git -C $projectRoot status --porcelain); payload = $payload; zip = @{ file = 'client.zip'; sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $zip).Length }; installer = @{ file = [IO.Path]::GetFileName($installer); sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $installer).Length }; webViewSdk = $sdkVersion }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $buildRoot 'release.json') -Encoding utf8
Write-Output "Desktop client built: $installer"
