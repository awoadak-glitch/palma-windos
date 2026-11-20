@echo off
setlocal
set "PALMA_INSTALL_DIR=%~dp0"
set "PALMA_INSTALL_SELF=%~f0"
echo PALMA VISION @VERSION@ - Update feature setup
echo Close PALMA before continuing.
if not exist "%~dp0PALMA VISION.exe" (
  echo ERROR: Copy this BAT and the resources folder beside PALMA VISION.exe first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -Command "$p=[IO.File]::ReadAllText($env:PALMA_INSTALL_SELF);$marker='#'+'POWERSHELL-BEGIN';$code=$p.Substring($p.IndexOf($marker)+$marker.Length);& ([ScriptBlock]::Create($code))"
set "PALMA_INSTALL_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PALMA_INSTALL_EXIT%
#POWERSHELL-BEGIN
$ErrorActionPreference = 'Stop'
try {
  $root = $env:PALMA_INSTALL_DIR
  $target = Join-Path $root 'resources\app.asar'
  $candidate = Join-Path $root 'resources\palma-update.asar'
  if (!(Test-Path -LiteralPath $candidate)) {
    throw 'Update archive is missing. Extract the setup ZIP again.'
  }
  $running = Get-Process -Name 'PALMA VISION' -ErrorAction SilentlyContinue
  if ($running) { throw 'Close PALMA VISION completely, then run this BAT again.' }
  if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne '@ARCHIVE_SHA256@') { throw 'Update checksum failed. Download the setup ZIP again.' }
  if (!(Test-Path -LiteralPath $target)) { throw 'Existing PALMA app.asar was not found.' }
  $backup = Join-Path $root ('resources\app-before-@VERSION@-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.asar')
  $temporary = Join-Path $root ('resources\palma-install-' + [guid]::NewGuid().ToString('N') + '.tmp')
  Copy-Item -LiteralPath $candidate -Destination $temporary
  if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne '@ARCHIVE_SHA256@') { throw 'Copied update checksum failed.' }
  try { [IO.File]::Replace($temporary, $target, $backup) } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
  Write-Host 'Installed PALMA @VERSION@ successfully.'
  Write-Host 'Open PALMA > Settings > Updates.'
  Write-Host ('Previous version backup: ' + $backup)
} catch {
  Write-Host ('ERROR: ' + $_.Exception.Message)
  exit 1
}
