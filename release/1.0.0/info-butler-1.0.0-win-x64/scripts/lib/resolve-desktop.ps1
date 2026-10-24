param([string]$OutFile)
# Resolve the real Desktop folder and write it as UTF-8 (no BOM).
# The desktop can be redirected to another drive (e.g. D:\Desktop) or into
# OneDrive; guessing %USERPROFILE%\Desktop would create shortcuts where the
# user cannot see them. Chinese paths are returned via a UTF-8 file instead of
# the console, because PS 5.1 writes console output in the system codepage.
$paths = @()
try { $paths += [Environment]::GetFolderPath('Desktop') } catch { }
try {
    $k = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    if ($k.Desktop) { $paths += [Environment]::ExpandEnvironmentVariables($k.Desktop) }
} catch { }
try {
    $k2 = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -ErrorAction Stop
    if ($k2.Desktop) { $paths += [Environment]::ExpandEnvironmentVariables($k2.Desktop) }
} catch { }
$paths += (Join-Path $env:USERPROFILE 'Desktop')
# OneDrive-backed desktop (folder name may have a localized suffix, so match
# by wildcard to keep this script pure ASCII).
try {
    Get-ChildItem -Path $env:USERPROFILE -Filter 'OneDrive*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $paths += (Join-Path $_.FullName 'Desktop')
    }
} catch { }

$result = ''
foreach ($p in $paths) {
    if ($p -and (Test-Path -LiteralPath $p)) { $result = $p; break }
}
if (-not $result) { $result = Join-Path $env:USERPROFILE 'Desktop' }
if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $result, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output ("DESKTOP=" + $result)
exit 0
