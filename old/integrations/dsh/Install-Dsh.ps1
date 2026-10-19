param(
    [string]$DshRoot = $(if ($env:MEMORA_DSH_ROOT) { $env:MEMORA_DSH_ROOT } else { '<DSH install dir>' }),
    [string]$Profile = 'desktop',
    [switch]$Check,
    [int]$HeartbeatIntervalMs = 30000,
    [int]$Attempts = 3
)
$ErrorActionPreference = 'Stop'
# This script lives in <dev>/integrations/dsh/. The installer it drives lives in <dev>/tools and
# the interpreter is <dev>/.venv, so both anchors come from the repository root instead of
# counting directory levels (the previous version counted levels for the retired
# devel/integrations layout and looked for the interpreter one directory too high).
$devDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pythonPath = Join-Path $devDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw "Project interpreter not found: $pythonPath" }
$installer = Join-Path $devDir 'tools\install_dsh.py'
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
$manifestPath = Join-Path $devDir 'runtime\dsh-install.json'

$arguments = @($installer, '--dsh', $DshRoot, '--profile', $Profile,
    '--heartbeat-interval-ms', $HeartbeatIntervalMs)

if ($Check) {
    & $pythonPath @arguments --check
    exit $LASTEXITCODE
}

$resolvedDsh = (Resolve-Path -LiteralPath $DshRoot).Path
# The hash guard is a race guard between staging and the copy, not a reason to leave the user
# stuck: the profile patch is a live document other tools edit, so "changed during staging"
# means "re-render against the current bytes and try again", which is exactly what the next
# attempt does (the installer re-reads the file and re-backs it up).
$applied = $false
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & $pythonPath @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage DSH integration' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $target = [IO.Path]::GetFullPath($manifest.target)
    if (-not $target.StartsWith($resolvedDsh + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Integration target must remain in the named DSH deployment'
    }
    $currentHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne $manifest.original_sha256) {
        Write-Output ("Profile patch changed while staging (attempt {0}/{1}); re-rendering against the current bytes." -f $attempt, $Attempts)
        continue
    }
    Write-Output ''
    Write-Output 'Will replace:'
    Write-Output ("  target        : {0}" -f $target)
    Write-Output ("  backups       : {0}" -f $manifest.backups)
    Write-Output ("  staged        : {0}" -f $manifest.generated)
    Write-Output ("  adapter       : {0}" -f $manifest.adapter)
    Copy-Item -LiteralPath $manifest.generated -Destination $target -Force
    $applied = $true
    break
}
if (-not $applied) { throw "Profile patch kept changing during staging ($Attempts attempts); close whatever is editing it and rerun." }

Write-Output ''
Write-Output 'Memora integration staged and applied (paths, connector backend and heartbeat).'
Write-Output 'Verify with : powershell -NoProfile -File integrations/dsh/Install-Dsh.ps1 -Check'
Write-Output 'Activate    : reload the DSH profile (or restart DSH) so the new plugin paths load.'
