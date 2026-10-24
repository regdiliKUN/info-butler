param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

# Windows shortcut generator for Info Butler.
# All non-ASCII paths come from the JSON config (read with -Encoding UTF8), never
# from the command line, to avoid console codepage mojibake.
# Robustness: each link is "delete then create"; one failure never aborts the rest.
# Read-only mode (cfg.read = $true) reports each .lnk's real TargetPath for verification.

$ErrorActionPreference = 'Continue'

$raw = Get-Content -Path $ConfigPath -Raw -Encoding UTF8
$cfg = $raw | ConvertFrom-Json

$shell = $null
$expected = 0
$created = 0
$failed = @()
$errDetail = @()

function Ensure-Dir($p) {
    if (-not (Test-Path -LiteralPath $p)) {
        try { New-Item -ItemType Directory -Path $p -Force | Out-Null } catch { }
    }
}

function Remove-OldLink($p) {
    # Try progressively stronger removal; returns $true if the path is free afterwards.
    if (-not (Test-Path -LiteralPath $p)) { return $true }
    Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $p)) { return $true }
    try {
        Set-ItemProperty -LiteralPath $p -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
        [System.IO.File]::Delete($p)
    } catch { }
    if (-not (Test-Path -LiteralPath $p)) { return $true }
    # Delete denied (e.g. a protected Desktop in a sandboxed shell): rename the stale
    # link aside so a fresh one can be written at the same path. Renaming needs weaker
    # permissions than unlinking and works where Remove-Item/File.Delete are refused.
    try {
        $stamp = [DateTime]::Now.ToString('HHmmss')
        [System.IO.File]::Move($p, ($p + '.old-' + $stamp))
    } catch { }
    return (-not (Test-Path -LiteralPath $p))
}

function Save-Shortcut($l, $shell) {
    try {
        if (Test-Path -LiteralPath $l.linkPath) {
            # Already exists: if target AND icon match, it is ready (the active desktop
            # entry is often locked by Explorer, so overwriting may fail; skip if correct).
            $ex = $null
            try { $ex = $shell.CreateShortcut($l.linkPath) } catch { }
            $exIcon = ""
            try { $exIcon = [string]$ex.IconLocation } catch { }
            if ($ex -and $ex.TargetPath -eq $l.target -and $exIcon -eq [string]$l.icon) {
                return $true
            }
            Remove-OldLink $l.linkPath | Out-Null
            # Best effort: clean up any ".old-*" leftovers from previous runs.
            $dir = Split-Path -Parent $l.linkPath
            $base = Split-Path -Leaf $l.linkPath
            Get-ChildItem -LiteralPath $dir -Filter ($base + '.old-*') -ErrorAction SilentlyContinue |
                ForEach-Object { try { [System.IO.File]::Delete($_.FullName) } catch { } }
        }
        $sc = $shell.CreateShortcut($l.linkPath)
        $sc.TargetPath = $l.target
        if ($l.args) { $sc.Arguments = $l.args }
        if ($l.workDir) { $sc.WorkingDirectory = $l.workDir }
        if ($l.icon) { $sc.IconLocation = $l.icon }
        if ($l.windowStyle) { $sc.WindowStyle = [int]$l.windowStyle }
        if ($l.description) { $sc.Description = $l.description }
        $sc.Save()
        return $true
    } catch {
        $script:errDetail += ($l.linkPath + " :: " + $_.Exception.Message)
        return $false
    }
}

function New-OneShortcut($l) {
    Ensure-Dir (Split-Path -Parent $l.linkPath)
    $ok = Save-Shortcut $l $shell
    if (-not $ok) { $ok = Save-Shortcut $l $shell }
    return $ok
}

if (-not $cfg) { Write-Output "ERR: config empty"; exit 2 }

if ($cfg.dirs) { foreach ($d in $cfg.dirs) { Ensure-Dir $d } }

if ($cfg.links) {
    try { $shell = New-Object -ComObject WScript.Shell } catch { Write-Output "ERR: cannot create WScript.Shell"; exit 2 }
    if ($cfg.read) {
        $readLines = @()
        foreach ($l in $cfg.links) {
            $t = ""
            $ic = ""
            try {
                $sc = $shell.CreateShortcut($l.linkPath)
                $t = $sc.TargetPath
                $ic = [string]$sc.IconLocation
            } catch { }
            $readLines += ("READ|" + $l.linkPath + "|" + $t)
            $readLines += ("READICON|" + $l.linkPath + "|" + $ic)
        }
        if ($cfg.readOut) {
            # Console output goes through the system codepage (GBK on zh-CN), so
            # non-ASCII paths would reach Node as mojibake. Write a UTF-8 file instead.
            Set-Content -LiteralPath $cfg.readOut -Value $readLines -Encoding UTF8
        }
        foreach ($line in $readLines) { Write-Output $line }
        exit 0
    }
    foreach ($l in $cfg.links) {
        $expected++
        if (New-OneShortcut $l) { $created++ } else { $failed += $l.linkPath }
    }
}

if ($cfg.urlFiles) {
    foreach ($u in $cfg.urlFiles) {
        $expected++
        try {
            $dir = Split-Path -Parent $u.path
            Ensure-Dir $dir
            if (Test-Path -LiteralPath $u.path) { Remove-OldLink $u.path | Out-Null }
            $body = "[InternetShortcut]`r`nURL=" + $u.url + "`r`n"
            Set-Content -LiteralPath $u.path -Value $body -Encoding ASCII
            $created++
        } catch { $failed += $u.path }
    }
}

if ($cfg.remove) {
    foreach ($r in $cfg.remove) {
        if (Test-Path -LiteralPath $r) { Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Output ("CREATED=" + $created + " EXPECTED=" + $expected)
if ($failed.Count -gt 0) {
    Write-Output ("FAILED=" + ($failed -join ' | '))
}
if ($errDetail.Count -gt 0) {
    Write-Output ("ERRDETAIL=" + ($errDetail -join ' | '))
}

if ($created -eq $expected) { exit 0 } else { exit 1 }
