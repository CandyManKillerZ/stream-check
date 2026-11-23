# Builds the Windows app.  Output: dist\StreamCheck-<version>-windows-x64.exe
# Needs Go 1.23+, Node 18+, and the Wails CLI (go install github.com/wailsapp/wails/v2/cmd/wails@latest).
$ErrorActionPreference = 'Continue'  # native tools write warnings to stderr; exit codes are checked instead
$root = Split-Path $PSScriptRoot -Parent
Push-Location (Join-Path $root 'desktop')
try {
    wails build -clean -trimpath -ldflags '-s -w'
    if ($LASTEXITCODE -ne 0) { throw 'wails build failed' }
} finally { Pop-Location }
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $out | Out-Null
$dest = Join-Path $out "StreamCheck-$version-windows-x64.exe"
Copy-Item (Join-Path $root 'desktop\build\bin\Stream Check.exe') $dest -Force
Write-Host "EXE: $dest" -ForegroundColor Green
