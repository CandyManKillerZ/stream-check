# Builds the Android APK.  Output: dist\StreamCheck-<version>-android.apk
#   .\scripts\build-android.ps1            signed release (needs android\keystore.properties)
#   .\scripts\build-android.ps1 -Debug     debug build, no keystore needed
param([switch]$Debug)
$ErrorActionPreference = 'Continue'  # native tools write warnings to stderr; exit codes are checked instead
$root = Split-Path $PSScriptRoot -Parent

# Gradle cannot run on very new JDKs; use Android Studio's bundled JBR when it is there.
$jbr = 'C:\Program Files\Android\Android Studio\jbr'
if (Test-Path $jbr) { $env:JAVA_HOME = $jbr }

# Point Gradle at the Android SDK (local.properties is machine-specific and gitignored).
$localProps = Join-Path $root 'android\local.properties'
if (-not (Test-Path $localProps)) {
    $sdk = (Join-Path $env:LOCALAPPDATA 'Android\Sdk') -replace '\\', '/'
    Set-Content $localProps "sdk.dir=$sdk" -Encoding ascii
}

Push-Location $root
try {
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
    Push-Location android
    try {
        if ($Debug) { .\gradlew.bat assembleDebug } else { .\gradlew.bat assembleRelease }
        if ($LASTEXITCODE -ne 0) { throw 'gradle build failed' }
    } finally { Pop-Location }
} finally { Pop-Location }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$kind = if ($Debug) { 'debug' } else { 'release' }
$apk = Get-ChildItem (Join-Path $root "android\app\build\outputs\apk\$kind") -Filter *.apk | Select-Object -First 1
if ($apk.Name -like '*unsigned*') { Write-Warning 'APK is UNSIGNED: create android\keystore.properties (see README) to sign it.' }
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $out | Out-Null
$suffix = if ($Debug) { '-debug' } else { '' }
$dest = Join-Path $out "StreamCheck-$version-android$suffix.apk"
Copy-Item $apk.FullName $dest -Force
Write-Host "APK: $dest" -ForegroundColor Green
