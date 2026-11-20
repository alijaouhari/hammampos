# HammamPOS remote support setup (run in PowerShell as Administrator)
#
#   Installs Tailscale (private network) and the Windows OpenSSH server, so the
#   HammamPOS support PC can connect to this machine for tests and fixes.
#   Security:
#     - SSH accepts ONLY the support key below (no passwords).
#     - Port 22 is opened ONLY to Tailscale addresses (100.64.0.0/10), never the internet.
#     - Undo at any time:  & ([scriptblock]::Create((irm https://hammamposdashboard.vercel.app/remote-setup.ps1))) -Remove
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$SupportKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDKUdJzYIe4HK8/AcSZAg3Kf3qMWIuhG2BkVr7MLRC12 hammampos-support@alija-pc'
$RuleName = 'HammamPOS-Support-SSH (Tailscale only)'
$AdminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$TS = 'C:\Program Files\Tailscale\tailscale.exe'

function Say($m, $c = 'Cyan') { Write-Host ''; Write-Host "==> $m" -ForegroundColor $c }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Please run PowerShell as Administrator (right-click Start > Windows PowerShell (Admin)) and paste the command again.' -ForegroundColor Red
    return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# A 32-bit PowerShell window ("Windows PowerShell (x86)") cannot set up services and
# settings correctly on 64-bit Windows: run the same script in the 64-bit one.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    Say 'This is the 32-bit PowerShell. Continuing in the 64-bit PowerShell...' 'Yellow'
    $ps64 = Join-Path $env:WINDIR 'SysNative\WindowsPowerShell\v1.0\powershell.exe'
    $arg = if ($Remove) { ' -Remove' } else { '' }
    $cmd = "[Net.ServicePointManager]::SecurityProtocol='Tls12'; & ([scriptblock]::Create((irm https://hammamposdashboard.vercel.app/remote-setup.ps1)))$arg"
    & $ps64 -NoProfile -ExecutionPolicy Bypass -Command $cmd
    return
}

if ($Remove) {
    Say 'Removing remote support access'
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (Test-Path $AdminKeys) {
        (Get-Content $AdminKeys | Where-Object { $_ -notmatch 'hammampos-support@' }) | Set-Content $AdminKeys -Encoding ascii
    }
    $userKeys = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
    if (Test-Path $userKeys) {
        (Get-Content $userKeys | Where-Object { $_ -notmatch 'hammampos-support@' }) | Set-Content $userKeys -Encoding ascii
    }
    Stop-Service sshd -ErrorAction SilentlyContinue
    Set-Service sshd -StartupType Disabled -ErrorAction SilentlyContinue
    Say 'Done. SSH is stopped and the support key removed. (Tailscale stays installed; uninstall it from Settings > Apps if you want.)' 'Green'
    return
}

# 1. Tailscale
if (-not (Test-Path $TS)) {
    Say 'Installing Tailscale...'
    $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
    Invoke-WebRequest -UseBasicParsing 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
    Start-Sleep 5
}
if (-not (Test-Path $TS)) { throw 'Tailscale did not install. Check the internet connection and try again.' }

$state = $null
try { $state = (& $TS status --json 2>$null | ConvertFrom-Json).BackendState } catch {}
if ($state -ne 'Running') {
    Say 'Sign in to Tailscale: a browser page will open. Use the SAME account as on the support PC.' 'Yellow'
    $log = Join-Path $env:TEMP 'tailscale-up.txt'
    Remove-Item $log -ErrorAction SilentlyContinue
    $name = 'hammam-' + ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '')
    Start-Process -FilePath $TS -ArgumentList 'up', '--unattended', "--hostname=$name" -RedirectStandardError $log -WindowStyle Hidden
    $opened = $false
    for ($i = 0; $i -lt 300; $i++) {
        Start-Sleep 2
        if (-not $opened -and (Test-Path $log)) {
            $url = (Select-String -Path $log -Pattern 'https://login\.tailscale\.com/\S+' -ErrorAction SilentlyContinue | Select-Object -First 1).Matches.Value
            if ($url) { Start-Process $url; Write-Host "If no browser opened, open this link: $url"; $opened = $true }
        }
        try { $state = (& $TS status --json 2>$null | ConvertFrom-Json).BackendState } catch {}
        if ($state -eq 'Running') { break }
    }
    if ($state -ne 'Running') { throw 'Tailscale sign-in was not completed (10 minutes). Run the command again.' }
}
Say 'Tailscale connected.' 'Green'

# 2. OpenSSH server: the official Microsoft package (fast). The Windows-Update
#    feature install (Add-WindowsCapability) is NOT used: it often hangs for a long time.
function Register-ExistingSshd {
    $scripts = @()
    foreach ($dir in @('C:\Program Files\OpenSSH', 'C:\Windows\System32\OpenSSH')) {
        if (Test-Path $dir) { $scripts += Get-ChildItem $dir -Recurse -Filter 'install-sshd.ps1' -ErrorAction SilentlyContinue }
    }
    foreach ($sc in $scripts) {
        if (-not (Test-Path (Join-Path $sc.DirectoryName 'sshd.exe'))) { continue }
        Say "Registering the SSH service from $($sc.DirectoryName)..."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sc.FullName | Out-Host
        Start-Sleep 2
        if (Get-Service sshd -ErrorAction SilentlyContinue) { return $true }
    }
    # last resort: the program is there but without its setup script
    foreach ($exe in @('C:\Program Files\OpenSSH\sshd.exe', 'C:\Windows\System32\OpenSSH\sshd.exe')) {
        if (Test-Path $exe) {
            Say "Creating the SSH service for $exe..."
            New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName "`"$exe`"" -StartupType Automatic | Out-Null
            if (Get-Service sshd -ErrorAction SilentlyContinue) { return $true }
        }
    }
    return $false
}

if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { [void](Register-ExistingSshd) }

if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Say 'Installing the OpenSSH server (about 1 minute)...'
    $rel = Invoke-RestMethod -TimeoutSec 60 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest'
    # a) the official installer package, with a log
    $asset = $rel.assets | Where-Object { $_.name -match 'Win64.*\.msi$' } | Select-Object -First 1
    if ($asset) {
        $msi2 = Join-Path $env:TEMP 'openssh.msi'
        $msiLog = Join-Path $env:TEMP 'openssh-install.log'
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 $asset.browser_download_url -OutFile $msi2
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi2`" /quiet /norestart /l*v `"$msiLog`"" -Wait -PassThru
        Start-Sleep 3
        if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Write-Host "Installer package did not work (code $($p.ExitCode)). Trying the ZIP version..." -ForegroundColor Yellow }
    }
    # b) the official ZIP version + its own service setup script (no installer involved)
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
        $zipAsset = $rel.assets | Where-Object { $_.name -eq 'OpenSSH-Win64.zip' } | Select-Object -First 1
        if (-not $zipAsset) { throw 'Could not find the OpenSSH ZIP package. Try again later.' }
        $zip = Join-Path $env:TEMP 'OpenSSH-Win64.zip'
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 $zipAsset.browser_download_url -OutFile $zip
        $unz = Join-Path $env:TEMP 'openssh-zip'
        if (Test-Path $unz) { Remove-Item $unz -Recurse -Force -ErrorAction SilentlyContinue }
        Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force
        $src = (Get-ChildItem $unz -Recurse -Filter 'sshd.exe' | Select-Object -First 1).DirectoryName
        $dest = 'C:\Program Files\OpenSSH'
        New-Item -ItemType Directory -Force $dest | Out-Null
        Copy-Item (Join-Path $src '*') $dest -Recurse -Force
        [void](Register-ExistingSshd)
    }
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'OpenSSH did not install. Details for support:' -ForegroundColor Red
    Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue | Format-List Name, State
    $msiLog = Join-Path $env:TEMP 'openssh-install.log'
    if (Test-Path $msiLog) { Get-Content $msiLog -Encoding Unicode | Select-String -Pattern 'error|failed|Erreur|1603|1618|1925' | Select-Object -Last 8 }
    throw 'OpenSSH did not install. Send a photo of this window to support.'
}
Start-Service sshd
Set-Service sshd -StartupType Automatic
Start-Sleep 2

# 3. Key-only login
$cfg = 'C:\ProgramData\ssh\sshd_config'
$text = Get-Content $cfg -Raw
foreach ($pair in @(@('PasswordAuthentication', 'no'), @('PubkeyAuthentication', 'yes'))) {
    $k = $pair[0]; $v = $pair[1]
    if ($text -match "(?m)^\s*#?\s*$k\s+\S+") { $text = [regex]::Replace($text, "(?m)^\s*#?\s*$k\s+\S+", "$k $v") }
    else { $text = "$k $v`r`n" + $text }
}
Set-Content $cfg $text -Encoding ascii

foreach ($f in @($AdminKeys, (Join-Path $env:USERPROFILE '.ssh\authorized_keys'))) {
    $dir = Split-Path $f
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir -Force | Out-Null }
    $lines = @(); if (Test-Path $f) { $lines = @(Get-Content $f | Where-Object { $_ -notmatch 'hammampos-support@' }) }
    ($lines + $SupportKey) | Set-Content $f -Encoding ascii
}
# administrators_authorized_keys must be readable only by Administrators and SYSTEM (SIDs work on any Windows language)
icacls $AdminKeys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null

# PowerShell as the SSH shell
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
Restart-Service sshd

# 4. Firewall: SSH from Tailscale addresses only
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ne $RuleName -and ($_.DisplayName -match 'OpenSSH|sshd' -or $_.Name -match 'OpenSSH|sshd') } | Disable-NetFirewallRule
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress '100.64.0.0/10' -Action Allow -Profile Any | Out-Null

$ip = (& $TS ip -4 2>$null | Select-Object -First 1)
$me = (& $TS status --json | ConvertFrom-Json).Self.HostName
Say 'ALL DONE. Remote support is ready.' 'Green'
Write-Host "  Machine name : $me"
Write-Host "  Tailscale IP : $ip"
Write-Host "  Windows user : $env:USERNAME"
Write-Host ''
Write-Host 'Send these three lines to support. To remove access later, run the same command with -Remove (see top of the script).'
