# Copies a freshly built Daylight mod jar into the INSTALLED launcher, so a dev
# build can be tested without reinstalling.
#
# The installed app reads its bundled jars from its own program directory, not
# from this repo -- copying into the repo's bundled/ folder has no effect on an
# installed copy. That trips people up, so this does both.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\stage-dev-jar.ps1
#         powershell -ExecutionPolicy Bypass -File tools\stage-dev-jar.ps1 -Version 1.21.8

param(
    [string]$Version = "1.21.11"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$jarName = "daylight-mod-$Version.jar"
$source = Join-Path $repo "bundled\$jarName"

if (-not (Test-Path $source)) {
    Write-Host "No jar at $source" -ForegroundColor Red
    Write-Host "Build it first, then copy it into bundled\." -ForegroundColor Red
    exit 1
}

$installed = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter $jarName -ErrorAction SilentlyContinue |
             Select-Object -First 1

if (-not $installed) {
    Write-Host "Could not find an installed launcher containing $jarName." -ForegroundColor Yellow
    Write-Host "Is Daylight installed? Looked under $env:LOCALAPPDATA\Programs" -ForegroundColor Yellow
    exit 1
}

Copy-Item $source $installed.FullName -Force

# The launcher copies bundled -> pack by content hash at launch, so refreshing
# the installed copy is enough. Drop the pack copy too in case the game is
# mid-session and would otherwise keep the stale one.
$packJar = Join-Path $env:APPDATA ".daylight\packs\daylight\mods\daylight-mod.jar"
if (Test-Path $packJar) {
    Copy-Item $source $packJar -Force
    Write-Host "also refreshed the pack copy" -ForegroundColor DarkGray
}

$size = (Get-Item $source).Length
Write-Host "staged $jarName ($size bytes)" -ForegroundColor Green
Write-Host "  -> $($installed.FullName)" -ForegroundColor DarkGray
Write-Host "Relaunch the pack to pick it up."
