param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Data)
$ErrorActionPreference = 'Stop'
$expectedData = [IO.Path]::GetFullPath($Data)
$status = Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/agent/status') -TimeoutSec 3
if ($status.name -ne 'memora' -or $status.data_dir -ne $expectedData) { throw 'Refusing to stop a different runtime.' }
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
$process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
$command = $process.CommandLine.Replace('/', '\')
if ($process.Name -ne 'python.exe' -or $command -notmatch '-m memora' -or $command -notmatch '\bserve\b' -or -not $command.Contains($expectedData)) { throw 'Listener does not belong to this source memory host.' }
# The venv executable is a launcher. Stop the verified listening child; stopping
# only the launcher can leave the actual Python server alive with stale code.
Stop-Process -Id $process.ProcessId
Write-Output 'Stopped the verified source memory listener.'
