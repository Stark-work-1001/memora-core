param([string]$ApplicationDirectory = $PSScriptRoot, [switch]$ElectronRuntime)
$ErrorActionPreference = 'Stop'
# Repair integrity labels only. Never reset the discretionary ACL or disable Chromium's sandbox.
$root = (Resolve-Path -LiteralPath $ApplicationDirectory).Path
if ($root -eq [IO.Path]::GetPathRoot($root)) { throw 'A drive root is not an application directory.' }
$executable = if ($ElectronRuntime) { 'electron.exe' } else { 'Memora.exe' }
if (-not (Test-Path -LiteralPath (Join-Path $root $executable) -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $root 'resources') -PathType Container)) {
    throw 'This is not a complete Electron application directory.'
}
if (-not $ElectronRuntime -and -not (Test-Path -LiteralPath (Join-Path $root 'resources\backend\BUILD_MANIFEST.json'))) {
    throw 'Memora build manifest is missing; refusing to change labels.'
}
$roots = @((Get-Item -LiteralPath $root))
foreach ($name in @('resources', 'locales')) {
    $directory = Join-Path $root $name
    if (Test-Path -LiteralPath $directory) { $roots += Get-Item -LiteralPath $directory }
}
# Check links before any recursive operation; data/runtime and other user folders are excluded.
$pending = New-Object 'System.Collections.Generic.Stack[System.IO.FileSystemInfo]'
foreach ($item in $roots) { $pending.Push($item) }
while ($pending.Count) {
    $item = $pending.Pop()
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Refusing a linked application path: ' + $item.FullName) }
    if ($item -is [IO.DirectoryInfo]) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
            if ($item.FullName -ne $root -or -not ($child -is [IO.DirectoryInfo])) { $pending.Push($child) }
        }
    }
}
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
function Set-ProgramLabel([string]$target, [switch]$Tree) {
    $arguments = @($target, '/setintegritylevel', 'M', '/Q')
    if ($Tree) { $arguments = @($target, '/setintegritylevel', '(OI)(CI)M', '/T', '/Q') }
    $detail = & $icacls @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Cannot repair application integrity label: ' + $target + [Environment]::NewLine + ($detail -join [Environment]::NewLine)) }
}
# Root has no inheritance flags: existing data/runtime labels are not recursively changed.
Set-ProgramLabel $root
foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Force)) { Set-ProgramLabel $file.FullName }
foreach ($directory in $roots | Select-Object -Skip 1) { Set-ProgramLabel $directory.FullName -Tree }
Write-Output 'Application integrity labels repaired (Medium). Data folders and discretionary ACLs retained.'
