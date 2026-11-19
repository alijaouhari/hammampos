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

# 2. OpenSSH server
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
if (-not $cap -or $cap.State -ne 'Installed') {
    Say 'Installing the Windows OpenSSH server (can take a few minutes)...'
    try {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    } catch {
        Say 'Windows feature install failed, using the official OpenSSH package instead...' 'Yellow'
        $rel = Invoke-RestMethod 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest'
        $asset = $rel.assets | Where-Object { $_.name -match 'Win64.*\.msi$' } | Select-Object -First 1
        $msi2 = Join-Path $env:TEMP 'openssh.msi'
        Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $msi2
        Start-Process msiexec.exe -ArgumentList "/i `"$msi2`" /quiet /norestart" -Wait
    }
}
Start-Service sshd
Set-Service sshd -StartupType Automatic

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
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
Restart-Service sshd

# 4. Firewall: SSH from Tailscale addresses only
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
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
