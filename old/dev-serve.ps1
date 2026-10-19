<#
.SYNOPSIS
  Run the CURRENT SOURCE of memora as a live workbench, for development and review.

.DESCRIPTION
  Unlike start-memora.ps1, this does NOT launch the packaged desktop exe and does NOT build
  anything. It runs `python -m memora serve` straight from the working tree, so every edit is
  visible on the next page refresh. That is what makes it useful while the code is moving.

  It also makes sure the two local model services (embedding on 18181, judge on 18182) are up
  inside WSL, because without them retrieval silently degrades to lexical-only and the UI reports
  'Embedding 鏈厤缃? - which looks like a bug but is just the services being down.

.PARAMETER Port
  Workbench port. Default 8765, the one the desktop shell and the docs use.

.PARAMETER NoModels
  Skip the WSL model startup when you only need the UI.

.EXAMPLE
  .\dev-serve.ps1
  .\dev-serve.ps1 -Port 8770 -NoModels
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$NoModels
)
$ErrorActionPreference = 'Stop'
# This script lives at the ROOT of the development tree. The interpreter,
# the source and the live memory store are all here. The packaged application is a sibling one
# level up (..\memora-desktop-standalone) and serves its own data/ on its own port (18765), so a
# dev session and the installed app can run at the same time without sharing a database.
$devDir = $PSScriptRoot
$memoryDir = Split-Path -Parent $devDir
$pythonPath = Join-Path $devDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'No .venv found. Run the setup steps in README.zh-CN.md first.'
}

# Keep every temporary artefact inside the repo, so nothing leaks into %TEMP%.
$env:TEMP = Join-Path $devDir 'runtime\tmp'
$env:TMP = $env:TEMP
$env:PYTHONUTF8 = '1'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    throw "Port $Port is already in use by '$owner' (pid $($listener.OwningProcess))." +
          " Stop it, or pass -Port with a free one."
}

if (-not $NoModels) {
    # Probing the ports is cheaper and more honest than trusting a service manager's report.
    function Test-Port([int]$p) {
        $c = New-Object Net.Sockets.TcpClient
        try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Dispose() }
    }
    if (-not ((Test-Port 18181) -and (Test-Port 18182))) {
        Write-Host 'Model services are not both up; starting them in WSL (this can take a minute)...'
        $starter = Join-Path $devDir 'deployment\Start-Models.ps1'
        if (Test-Path -LiteralPath $starter) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter
        } else {
            Write-Warning 'deployment\Start-Models.ps1 is missing; continuing without models.'
        }
    }
    $emb = Test-Port 18181; $judge = Test-Port 18182
    Write-Host ("  embedding 18181: {0}   judge 18182: {1}" -f $(if($emb){'up'}else{'DOWN'}), $(if($judge){'up'}else{'DOWN'}))
    if (-not ($emb -and $judge)) {
        Write-Warning 'A model service is down: retrieval will fall back to lexical-only and the UI will say so.'
    }
}

Write-Host ''
Write-Host "Memora (source) -> http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''
& $pythonPath -m memora --data (Join-Path $devDir 'data') serve --port $Port
exit $LASTEXITCODE