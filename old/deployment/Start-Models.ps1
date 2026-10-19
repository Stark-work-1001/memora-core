param([string]$Distribution = 'rocky')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$pidFile = Join-Path $runtimeRoot 'wsl-host.pid'
$keepAlive = $null
if (Test-Path -LiteralPath $pidFile) {
    $storedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq 'wsl.exe' -and $candidate.CommandLine -like '*sleep*infinity*') { $keepAlive = $candidate }
}
if (-not $keepAlive) {
    $keepAlive = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" -ArgumentList @('-d',$Distribution,'--','sleep','infinity') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'wsl-host.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'wsl-host.err.log')
    $keepAlive.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
}
& wsl.exe -d $Distribution -- bash -lc 'systemctl --user start memora-embedding.service memora-judge.service'
if ($LASTEXITCODE -ne 0) { throw 'Failed to start Rocky model services; inspect the WSL service logs.' }
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $embedding = Invoke-RestMethod -Uri 'http://127.0.0.1:18181/health' -TimeoutSec 1
        $judge = Invoke-RestMethod -Uri 'http://127.0.0.1:18182/health' -TimeoutSec 1
        if ($embedding.status -eq 'ok' -and $judge.status -eq 'ok') { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'Model health checks timed out. Inspect systemctl --user status memora-embedding memora-judge inside Rocky.' }
Write-Output ('Models ready. WSL host PID: ' + (Get-Content -LiteralPath $pidFile -Raw).Trim())
