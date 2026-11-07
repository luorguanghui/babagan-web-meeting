param(
    [ValidateSet('Debug','Release')][string]$Configuration = 'Debug',
    [string]$DevelopmentRoot = (Join-Path $env:LOCALAPPDATA 'BabaganDevelopment'),
    [switch]$SkipTests,
    [string]$SigningStore,
    [string]$SigningAlias = 'babagan',
    [string]$SigningPasswordFile
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$gradle = Join-Path $DevelopmentRoot 'gradle-8.13\bin\gradle.bat'
if (!(Test-Path -LiteralPath $gradle)) { throw 'Run scripts/setup-android-dev.ps1 first.' }
$env:ANDROID_HOME = Join-Path $DevelopmentRoot 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = Join-Path $DevelopmentRoot 'gradle-cache'
$env:BABAGAN_ANDROID_BUILD_ROOT = Join-Path $DevelopmentRoot 'android-build'
$tasks = @('assemble' + $Configuration)
if (!$SkipTests) { $tasks += @('testDebugUnitTest','lintDebug') }
& $gradle -p (Join-Path $repo 'apps\android') --no-daemon @tasks
if ($LASTEXITCODE -ne 0) { throw 'Android build failed.' }
$apk = Join-Path $env:BABAGAN_ANDROID_BUILD_ROOT ("app\outputs\apk\{0}\app-{0}{1}.apk" -f $Configuration.ToLower(), $(if ($Configuration -eq 'Release') { '-unsigned' } else { '' }))
if ($Configuration -eq 'Release' -and $SigningStore) {
    if (!$SigningPasswordFile) { throw 'SigningPasswordFile is required for release signing.' }
    $output = Join-Path $repo 'artifacts\android\Babagan.apk'
    New-Item -ItemType Directory -Force -Path (Split-Path $output -Parent) | Out-Null
    $signer = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat'
    # PKCS12 uses the same key/store password. Passing the same file twice would consume two lines.
    & $signer sign --ks $SigningStore --ks-key-alias $SigningAlias --ks-pass "file:$SigningPasswordFile" --out $output $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & $signer verify --verbose $output
    if ($LASTEXITCODE -ne 0) { throw 'APK verification failed.' }
    $apk = $output
    $badging = (& (Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\aapt2.exe') dump badging $apk) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the signed APK.' }
    $package = [regex]::Match($badging, "package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'")
    if (!$package.Success) { throw 'Signed APK package metadata is missing.' }
    $certificates = (& $signer verify --print-certs $apk) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the APK signer.' }
    $fingerprint = [regex]::Match($certificates, 'Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})')
    if (!$fingerprint.Success) { throw 'APK signer fingerprint is missing.' }
    $release = [ordered]@{
        schema = 1
        product = 'babagan-client'
        platform = 'android'
        version = $package.Groups[3].Value
        versionCode = [long]$package.Groups[2].Value
        applicationId = $package.Groups[1].Value
        artifact = [ordered]@{ file = 'Babagan.apk'; sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $apk).Length }
        apkSignerSha256 = $fingerprint.Groups[1].Value.ToLowerInvariant()
        source = [ordered]@{
            commit = (& git -C $repo rev-parse HEAD).Trim()
            branch = ([string](& git -C $repo branch --show-current)).Trim()
            dirty = (@(& git -C $repo status --porcelain).Count -gt 0)
        }
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $release | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path (Split-Path $apk -Parent) 'release.json') -Encoding utf8
}
elseif ($Configuration -eq 'Debug') {
    $output = Join-Path $repo 'artifacts\android\Babagan-debug.apk'
    New-Item -ItemType Directory -Force -Path (Split-Path $output -Parent) | Out-Null
    Copy-Item -LiteralPath $apk -Destination $output -Force
    $apk = $output
}
Write-Output "APK: $apk"
