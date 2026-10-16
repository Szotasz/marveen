# Marveen - Windows telepítő (WSL alapú)
# Futtatás: PowerShell-ben: .\install-windows.ps1

# NOTE: wsl.exe emits its output as UTF-16LE, so PowerShell captures each char
# followed by a \0 byte ("U\0b\0u\0n\0t\0u\0"). `-match "Ubuntu"` then fails ->
# the script thinks Ubuntu is missing, re-runs `wsl --install -d Ubuntu` and
# exits EVERY time, never reaching [3/5] (2026-06-04 re-entry bug, kártya
# 3BB2E738). Fix: strip the stray \0 from wsl output before matching (see the
# `-replace "`0", ""` at each wsl-capture site below). We intentionally do NOT
# touch [Console]::OutputEncoding globally -- that can garble the banner glyphs
# on Windows PowerShell 5.1; the targeted null-strip is side-effect-free.

Write-Host ""
Write-Host "  ▐▛███▜▌   Marveen" -ForegroundColor Cyan
Write-Host " ▝▜█████▛▘  AI csapatod, ami fut amíg te alszol." -ForegroundColor Cyan
Write-Host "   ▘▘ ▝▝" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Windows telepítő (WSL alapú)" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Check if WSL is available
Write-Host "[1/3] WSL ellenőrzés..." -ForegroundColor White

$wslInstalled = $false
try {
    $wslOutput = (wsl --status 2>&1 | Out-String) -replace "`0", ""
    if ($LASTEXITCODE -eq 0 -or $wslOutput -match "Default Distribution") {
        $wslInstalled = $true
        Write-Host "  ✓ WSL telepítve" -ForegroundColor Green
    }
} catch {}

if (-not $wslInstalled) {
    Write-Host "  ✗ WSL nem található" -ForegroundColor Red
    Write-Host ""
    Write-Host "  A Marveen WSL-ben fut (Windows Subsystem for Linux)." -ForegroundColor Yellow
    Write-Host "  Telepítéshez futtasd rendszergazdaként:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    wsl --install" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Újraindítás után futtasd újra ezt a scriptet." -ForegroundColor Yellow
    Write-Host ""

    $doInstall = Read-Host "  Telepítsem most a WSL-t? (i/n)"
    if ($doInstall -eq "i") {
        Write-Host "  WSL telepítés indítása (rendszergazda jogok szükségesek)..." -ForegroundColor Yellow
        Start-Process -Verb RunAs -FilePath "wsl" -ArgumentList "--install" -Wait
        Write-Host ""
        Write-Host "  WSL telepítve. Indítsd újra a gépet, majd futtasd újra ezt a scriptet." -ForegroundColor Green
        exit 0
    }
    exit 1
}

# Step 2: Check WSL distro
Write-Host ""
Write-Host "[2/3] Linux disztribúció ellenőrzés..." -ForegroundColor White

# The distro may be registered as "Ubuntu", "Ubuntu-24.04", ... -- target the
# name that is actually there, not a hard-coded "Ubuntu".
$distros = (wsl --list --quiet 2>&1 | Out-String) -replace "`0", ""
$distroName = ($distros -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^Ubuntu" } | Select-Object -First 1)
$freshUbuntu = $false
if ($distroName) {
    Write-Host "  ✓ Ubuntu elérhető ($distroName)" -ForegroundColor Green
} else {
    Write-Host "  Ubuntu telepítése..." -ForegroundColor Yellow
    wsl --install -d Ubuntu
    $distroName = "Ubuntu"
    $freshUbuntu = $true
    Write-Host "  ✓ Ubuntu telepítve" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Az Ubuntu első indításakor létre kell hoznod egy Linux" -ForegroundColor Yellow
    Write-Host "  felhasználónevet és jelszót. Ha a telepítés most rögtön" -ForegroundColor Yellow
    Write-Host "  megnyitotta az Ubuntu ablakot, állítsd be ott a fiókot." -ForegroundColor Yellow
    Write-Host ""
}

# Step 3: hand over to install-linux.sh INSIDE WSL, with interactive stdin.
#
# This is the ONLY install path now, whether Ubuntu was just installed or was
# already there. The old steps 3-5 passed multi-line PowerShell here-strings to
# `wsl bash -c`, and that transport is broken in three independent ways
# (measured on Windows PowerShell 5.1 + WSL2): every line keeps a trailing CR
# from the CRLF script file (bash: "set: invalid option" on line 1), PowerShell
# strips the embedded double quotes when building the native command line
# (syntax errors), and PowerShell expands the `$VAR`s meant for bash with its
# own values (empty INSTALL_DIR, a Windows-side PATH). bash then exited 2, the
# exit code was never checked, and the script printed "Függőségek telepítve".
# Worse, a quote on the WEB_PORT line made Windows PowerShell 5.1 refuse to
# PARSE the file at all ("The token '&&' is not a valid statement separator"),
# so on 5.1 the installer stopped before running a single step. install-linux.sh
# does everything those steps did (and much more: auth check, systemd units,
# channel pairing), so the duplicate is removed instead of patched.
Write-Host ""
Write-Host "[3/3] Telepítés az Ubuntu-ban (install-linux.sh)..." -ForegroundColor White
if ($freshUbuntu) {
    $cont = Read-Host "  Folytassam most a telepítést az Ubuntu-ban? (i/n) [i]"
    $go = ([string]::IsNullOrEmpty($cont) -or $cont -eq "i")
} else {
    $go = $true
}
if ($go) {
    # No double quotes and no `$` inside this string on purpose: nothing for
    # PowerShell to strip or expand on its way to bash. The script is saved to
    # a file first so bash gets the terminal as stdin and the prompts work.
    wsl -d $distroName -- bash -c "curl -fsSL https://raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh -o /tmp/marveen-install.sh && bash /tmp/marveen-install.sh"
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "  ✓ Marveen telepítve az Ubuntu-ban (install-linux.sh)." -ForegroundColor Green
        exit 0
    }
    Write-Host ""
    Write-Host "  ✗ A telepítés az Ubuntu-ban nem fejeződött be (kilépési kód: $LASTEXITCODE)." -ForegroundColor Red
    if ($freshUbuntu) {
        Write-Host "  Friss Ubuntu-nál ez gyakran azt jelenti, hogy előbb újraindítás vagy a fiók beállítása kell." -ForegroundColor Yellow
    }
}
Write-Host ""
Write-Host "  Fejezd be így: indítsd el az Ubuntu-t (Start menü -> Ubuntu), állítsd" -ForegroundColor Yellow
Write-Host "  be a felhasználót ha még nem tetted, majd az Ubuntu shellben futtasd:" -ForegroundColor Yellow
Write-Host "    curl -fsSL https://raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh -o install.sh && bash install.sh" -ForegroundColor Cyan
Write-Host "  (vagy indítsd újra ezt a PowerShell scriptet, ha kell a gép-újraindítás)" -ForegroundColor DarkGray
if ($go) { exit 1 }
exit 0
