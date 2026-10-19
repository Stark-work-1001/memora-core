param([switch]$Headless, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$backend = Join-Path $packageRoot 'resources\backend\memora-backend.exe'
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'resources\backend\BUILD_MANIFEST.json') -Raw | ConvertFrom-Json
$workspace = $null
$candidate = $packageRoot
for ($depth = 0; $depth -lt 7; $depth++) {
    if ((Test-Path -LiteralPath (Join-Path $candidate 'pyproject.toml')) -and (Test-Path -LiteralPath (Join-Path $candidate 'memora\core.py'))) { $workspace = $candidate; break }
    $parent = Split-Path -Parent $candidate
    if (-not $parent -or $parent -eq $candidate) { break }
    $candidate = $parent
}
$storageRoot = if ($workspace) { $workspace } else { $packageRoot }
$data = if ($env:MEMORA_DATA) { [IO.Path]::GetFullPath($env:MEMORA_DATA) } else { Join-Path $storageRoot 'data' }
$runtimeRoot = if ($env:MEMORA_RUNTIME_DIR) { [IO.Path]::GetFullPath($env:MEMORA_RUNTIME_DIR) } else { Join-Path $storageRoot 'runtime' }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$record = Join-Path $runtimeRoot 'portable-host.json'
$old = if (Test-Path -LiteralPath $record) { Get-Content -LiteralPath $record -Raw | ConvertFrom-Json } else { $null }
# taskkill walks the tree. Stop-Process signals one process, and a backend that started a worker
# keeps the SQLite file open through it -- the next launch then meets a locked database. The
# command window that a Python child would otherwise open is suppressed here as well.
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
function Stop-Tree([int]$ProcessId, [string]$Reason) {
    & $taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Output ('Could not stop process tree ' + $ProcessId + ' (' + $Reason + ').') }
}
if ($Stop) {
    if ($old) {
        $reachable = $false
        try {
            $status = Invoke-RestMethod ($old.url + '/api/agent/status') -TimeoutSec 2
            $reachable = $true
        } catch { Write-Output 'Recorded portable host is no longer reachable.' }
        if ($reachable) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort ([Uri]$old.url).Port | Select-Object -First 1
            $owned = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
            if ($status.name -ne 'memora' -or $status.data_dir -ne $old.data -or $owned.ExecutablePath -ne $backend -or -not $owned.CommandLine.Contains($old.data)) { throw 'Refusing to stop a different portable runtime.' }
            Stop-Tree $owned.ProcessId 'recorded portable host'
        }
    }
    Write-Output 'Stopped only the portable memory host recorded by this launcher.'
    exit 0
}
& (Join-Path $packageRoot 'Repair-Desktop.ps1')
$env:TEMP = Join-Path $runtimeRoot 'tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:MEMORA_DATA = $data
$base = $null
$records = @($old)
$managed = Join-Path $runtimeRoot 'active.json'
if (Test-Path -LiteralPath $managed) { $records += (Get-Content -LiteralPath $managed -Raw | ConvertFrom-Json) }
foreach ($entry in $records) {
    if (-not $entry -or $entry.data -ne $data) { continue }
    try {
        $uri = [Uri]$entry.url
        if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.UserInfo) { continue }
        $status = Invoke-RestMethod ($uri.GetLeftPart([UriPartial]::Authority) + '/api/agent/status') -TimeoutSec 2
        if ($status.name -eq 'memora' -and $status.version -eq $manifest.version -and $status.data_dir -eq $data) { $base = $uri.GetLeftPart([UriPartial]::Authority); break }
    } catch { }
}
if (-not $base) {
    $stdout = Join-Path $runtimeRoot 'portable.out.log'
    $stderr = Join-Path $runtimeRoot 'portable.err.log'
    $hostProcess = Start-Process -FilePath $backend -ArgumentList @('--data',('"' + $data + '"'),'serve','--port','0') -WorkingDirectory $storageRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # The stdout line only says a socket was bound. The identity probe below is what decides that the
    # listener is THIS build serving THIS data directory; the announcement merely tells us where to
    # look, exactly as the desktop shell does. 45s matches the shell's budget: a cold start that
    # rebuilds an index is slow, not broken, and killing it at 16s was the old failure.
    for ($attempt = 0; $attempt -lt 225; $attempt++) {
        if ($hostProcess.HasExited) { throw 'Portable memory host exited; inspect runtime/portable.err.log.' }
        if (Test-Path -LiteralPath $stdout) {
            $line = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
            if ($line -match 'Memora: (http://127\.0\.0\.1:\d+)') {
                $candidateBase = $Matches[1]
                try {
                    $status = Invoke-RestMethod ($candidateBase + '/api/agent/status') -TimeoutSec 2
                    if ($status.name -eq 'memora' -and $status.version -eq $manifest.version -and $status.data_dir -eq $data) { $base = $candidateBase; break }
                } catch { }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $base) {
        Stop-Tree $hostProcess.Id 'startup timed out'
        throw 'Portable memory host startup timed out (45s): it never answered /api/agent/status as this build. Inspect runtime/portable.err.log and runtime/portable.out.log.'
    }
    @{ pid=$hostProcess.Id; url=$base; data=$data; version=$manifest.version } | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding UTF8
}
Write-Output ('Memora: ' + $base)
if (-not $Headless) {
    $env:MEMORA_RUNTIME_URL = $base
    $desktop = Start-Process -FilePath (Join-Path $packageRoot 'Memora.exe') -ArgumentList @('--user-data-dir="' + (Join-Path $runtimeRoot 'portable-desktop') + '"') -WorkingDirectory $storageRoot -WindowStyle Hidden -PassThru
    if ($desktop.WaitForExit(2000) -and $desktop.ExitCode -ne 0) {
        $url = if ($env:MEMORA_PROJECT) { $base + '/?project=' + [Uri]::EscapeDataString($env:MEMORA_PROJECT) } else { $base }
        Write-Output ('Desktop unavailable in this execution context. Web workbench: ' + $url)
        try { Start-Process -FilePath $url | Out-Null } catch { Write-Output ('Open in a browser: ' + $url) }
    }
}
