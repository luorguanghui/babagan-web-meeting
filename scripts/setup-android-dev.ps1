param([string]$DevelopmentRoot = (Join-Path $env:LOCALAPPDATA 'BabaganDevelopment'), [switch]$Emulator)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sdk = Join-Path $DevelopmentRoot 'android-sdk'
$cache = Join-Path $DevelopmentRoot 'downloads'
New-Item -ItemType Directory -Force -Path $sdk,$cache | Out-Null
function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$Sha256) {
    if (!(Test-Path -LiteralPath $Destination)) {
        & curl.exe --fail --location --retry 3 --output $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Sha256) { throw "Checksum mismatch: $Destination" }
}
$manager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (!(Test-Path -LiteralPath $manager)) {
    $zip = Join-Path $cache 'commandlinetools-win-15859902_latest.zip'
    Get-VerifiedDownload 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' $zip '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
    $expanded = Join-Path $DevelopmentRoot 'commandline-tools-unpack'
    Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools\latest') | Out-Null
    Copy-Item -Path (Join-Path $expanded 'cmdline-tools\*') -Destination (Join-Path $sdk 'cmdline-tools\latest') -Recurse -Force
}
$gradle = Join-Path $DevelopmentRoot 'gradle-8.13\bin\gradle.bat'
if (!(Test-Path -LiteralPath $gradle)) {
    $gradleUrl = 'https://services.gradle.org/distributions/gradle-8.13-bin.zip'
    $hashResponse = (Invoke-WebRequest -Uri "$gradleUrl.sha256").Content
    $hash = $(if ($hashResponse -is [byte[]]) { [Text.Encoding]::UTF8.GetString($hashResponse) } else { [string]$hashResponse }).Trim()
    $zip = Join-Path $cache 'gradle-8.13-bin.zip'
    Get-VerifiedDownload $gradleUrl $zip $hash
    Expand-Archive -LiteralPath $zip -DestinationPath $DevelopmentRoot -Force
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GRADLE_USER_HOME = Join-Path $DevelopmentRoot 'gradle-cache'
@('y') * 80 | & $manager "--sdk_root=$sdk" --licenses | Out-File -LiteralPath (Join-Path $DevelopmentRoot 'sdk-licenses.log')
& $manager "--sdk_root=$sdk" 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Android SDK installation failed.' }
if ($Emulator) {
    & $manager "--sdk_root=$sdk" 'emulator' 'system-images;android-35;google_apis;x86_64'
    if ($LASTEXITCODE -ne 0) { throw 'Android emulator installation failed.' }
}
Write-Output "Android SDK: $sdk"
Write-Output "Gradle: $gradle"
