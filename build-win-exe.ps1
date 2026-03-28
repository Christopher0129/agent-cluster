$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node .\scripts\build-win-exe.mjs
