$ErrorActionPreference = 'Stop'
# This script lives in <dev>/tools/. <dev> is the development repository (<project root>):
# the interpreter, the source, the build material and the live memory store are all inside it.
# The packaged application and the install packages are SIBLINGS of <dev>, one level up, so a build
# never overwrites the copy a user is running.
$devDir = Split-Path -Parent $PSScriptRoot
$python = Join-Path $devDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Install the project Python environment first.' }
if (((Get-Item -LiteralPath $python).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked Python launcher.' }
# A Low-labelled build interpreter cannot assign Medium labels to its output.
# Set only this project's launcher before creating the Python child; no elevation or DACL reset.
& (Join-Path $env:SystemRoot 'System32\icacls.exe') $python /setintegritylevel M /Q
if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare the build interpreter. Run this script from a normal Windows session.' }
$env:PYTHONUTF8 = '1'
# Scratch space must sit on the same volume as the databases SQLite creates (see main.cjs).
$env:TEMP = Join-Path $devDir 'runtime\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
Push-Location $devDir
try {
    & $python (Join-Path $PSScriptRoot 'build_desktop.py')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; no release was created.' }
} finally { Pop-Location }
