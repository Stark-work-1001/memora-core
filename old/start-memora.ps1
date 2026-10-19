param([int]$Port = 8765, [string]$Data = '', [string]$Project = 'dsh', [switch]$Headless, [switch]$NoModels)
$ErrorActionPreference = 'Stop'
# This script lives at the ROOT of the development tree (<project root>\). The interpreter,
# the source, the tools and the live memory store are all here; the packaged application and the
# install packages are siblings one level up.
#
# PORTS: this launcher and dev-serve.ps1 own 8765 (MCP HTTP 18184). The packaged application uses
# 18765 (desktop/main.cjs). The two never collide, so a dev session and the installed app can run
# at the same time against their own separate data directories.
$devDir = $PSScriptRoot
$memoryDir = Split-Path -Parent $devDir
$pythonPath = Join-Path $devDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Install the project Python environment first; see README.zh-CN.md.' }
$env:TEMP = Join-Path $devDir 'runtime\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
if ($Data -and $Data -ne (Join-Path $devDir 'data')) {
    & $pythonPath -m memora --data $Data serve --port $Port
    exit $LASTEXITCODE
}
if (-not $NoModels) { & (Join-Path $devDir 'deployment\Start-Models.ps1') }
& $pythonPath (Join-Path $devDir 'tools\runtime_manager.py') start --port $Port --no-models
if ($LASTEXITCODE -ne 0) { throw 'Memora startup failed; inspect runtime\host.err.log.' }
if (-not $Headless) {
    # A development launch opens the source shell against this exact development backend.
    # The sibling standalone application is launched only from its own directory by the user.
    $application = Join-Path $devDir 'desktop\node_modules\electron\dist\electron.exe'
    $url = 'http://127.0.0.1:' + $Port + '/?project=' + [Uri]::EscapeDataString($Project)
    $env:MEMORA_DATA = Join-Path $devDir 'data'
    $env:MEMORA_RUNTIME_URL = 'http://127.0.0.1:' + $Port
    if (Test-Path -LiteralPath $application) {
        $shellPath = Join-Path $devDir 'desktop'
        $desktopProfile = Join-Path $devDir 'runtime\dev-desktop'
        $desktop = Start-Process -FilePath $application -ArgumentList @(('"' + $shellPath + '"'), ('--user-data-dir="' + $desktopProfile + '"')) -WorkingDirectory $devDir -WindowStyle Hidden -PassThru
        if ($desktop.WaitForExit(2000) -and $desktop.ExitCode -ne 0) {
            Write-Output ('Source desktop exited with ' + $desktop.ExitCode + '. Development workbench: ' + $url)
            try { Start-Process -FilePath $url | Out-Null } catch { Write-Output ('Open in a browser: ' + $url) }
        }
    } else {
        Write-Output ('Development workbench: ' + $url)
        try { Start-Process -FilePath $url | Out-Null } catch { Write-Output ('Open in a browser: ' + $url) }
    }
}
