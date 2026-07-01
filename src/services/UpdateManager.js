/**
 * HammamPOS - UpdateManager v3.0.0 (Production)
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * ROOT CAUSE OF PREVIOUS FAILURE:
 * ================================
 * Electron/Chromium uses Windows Job Objects. When Electron exits, the
 * Job Object is destroyed and ALL child processes (including "detached"
 * PowerShell) are terminated. Node's detached:true does NOT escape this.
 *
 * SOLUTION: WScript.exe COM launcher via ShellExecuteEx
 * =====================================================
 * WScript.Shell.Run uses the Win32 ShellExecuteEx API which creates
 * the child process OUTSIDE the caller's Job Object. Standard Windows
 * pattern for fire-and-forget launches that must survive parent death.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GITHUB_OWNER = 'alijaouhari';
const GITHUB_REPO = 'hammampos';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

class UpdateManager {
  constructor() {
    this.currentVersion = require('../../package.json').version;
    this.installDir = this._resolveInstallDir();
    this.stagingDir = this.installDir + '-update';
    this.oldDir = this.installDir + '-old';
    this.oldPreviousDir = this.installDir + '-old-previous';
    this.dataDir = path.join(process.env.APPDATA, 'HammamPOS');
    this.updatesDir = path.join(this.dataDir, 'updates');
    this.logsDir = path.join(this.dataDir, 'Logs');
    this.flagPath = path.join(this.dataDir, 'update-success.flag');
    this.statePath = path.join(this.dataDir, 'update-state.json');
    this.latestRelease = null;
    this.downloadProgress = 0;
    this.isDownloading = false;

    [this.updatesDir, this.logsDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    this._startupRecovery();
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════

  async checkForUpdate() {
    try {
      const release = await this._fetchLatestRelease();
      if (!release) return null;
      const remoteVersion = release.tag_name.replace(/^v/, '');
      if (!this._isNewer(remoteVersion, this.currentVersion)) return null;
      const zipAsset = release.assets.find(a => a.name.endsWith('.zip'));
      if (!zipAsset) return null;
      this.latestRelease = {
        version: remoteVersion,
        tag: release.tag_name,
        notes: release.body || '',
        downloadUrl: zipAsset.browser_download_url,
        size: zipAsset.size
      };
      this._log('INFO', 'Update available', { current: this.currentVersion, available: remoteVersion });
      return this.latestRelease;
    } catch (error) {
      this._log('ERROR', 'Update check failed', { error: error.message });
      return null;
    }
  }

  async downloadUpdate() {
    if (!this.latestRelease) throw new Error('لا يوجد تحديث');
    if (this.isDownloading) throw new Error('التحميل جاري بالفعل');
    this.isDownloading = true;
    this.downloadProgress = 0;
    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);
    this._log('INFO', 'Download started', { version: this.latestRelease.version, expectedSize: this.latestRelease.size });
    try {
      await this._download(this.latestRelease.downloadUrl, zipPath);
      const actualSize = fs.statSync(zipPath).size;
      if (this.latestRelease.size && Math.abs(actualSize - this.latestRelease.size) > 1024) {
        throw new Error(`حجم الملف غير صحيح: متوقع ${this.latestRelease.size}, فعلي ${actualSize}`);
      }
      // Validate ZIP integrity
      try {
        execSync(`powershell -NoProfile -Command "Add-Type -A 'System.IO.Compression.FileSystem'; [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}').Dispose()"`, { timeout: 30000, windowsHide: true });
      } catch (zipErr) {
        this._log('ERROR', 'ZIP validation failed', { error: zipErr.message ? zipErr.message.substring(0, 200) : 'unknown' });
        throw new Error('ملف ZIP تالف — أعد التحميل');
      }
      this._log('INFO', 'Download verified', { size: actualSize });
      this._setState('download_complete', { size: actualSize });
      this.isDownloading = false;
      return { success: true };
    } catch (error) {
      this.isDownloading = false;
      this._log('ERROR', 'Download failed', { error: error.message });
      try { fs.unlinkSync(zipPath); } catch (_) {}
      throw error;
    }
  }

  applyAndRestart() {
    if (!this.latestRelease) throw new Error('لا يوجد تحديث');
    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error('ملف التحديث غير موجود. أعد التحميل.');

    // Prevent concurrent updates
    const lockPath = path.join(this.updatesDir, 'update.lock');
    if (fs.existsSync(lockPath)) {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age < 10 * 60 * 1000) { // Less than 10 minutes old = still active
        throw new Error('تحديث آخر قيد التنفيذ. انتظر حتى ينتهي.');
      }
      // Stale lock — remove it
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }

    // Remove stale success flag
    try { fs.unlinkSync(this.flagPath); } catch (_) {}

    this._log('INFO', 'Apply initiated', { currentVersion: this.currentVersion, targetVersion: this.latestRelease.version });
    this._setState('apply_initiated');

    // Write PS1 updater
    const ps1Path = path.join(this.updatesDir, 'hammampos-updater.ps1');
    const ps1Content = this._buildUpdatePS1(zipPath, lockPath);
    fs.writeFileSync(ps1Path, ps1Content, 'utf8');
    this._log('INFO', 'PS1 written', { path: ps1Path, size: ps1Content.length });

    // Write VBS launcher (Job Object escape)
    const vbsPath = path.join(this.updatesDir, 'launch-updater.vbs');
    fs.writeFileSync(vbsPath, this._buildVBS(ps1Path), 'utf8');
    this._log('INFO', 'VBS written', { path: vbsPath, ps1Path });

    // Launch via ShellExecuteEx — independent of Electron
    this._launchVBS(vbsPath);
    return { success: true };
  }

  revertAndRestart() {
    if (!fs.existsSync(this.oldDir)) throw new Error('لا توجد نسخة سابقة للرجوع إليها');
    this._log('INFO', 'Revert initiated');

    const ps1Path = path.join(this.updatesDir, 'hammampos-revert.ps1');
    fs.writeFileSync(ps1Path, this._buildRevertPS1(), 'utf8');

    const vbsPath = path.join(this.updatesDir, 'launch-revert.vbs');
    fs.writeFileSync(vbsPath, this._buildVBS(ps1Path), 'utf8');

    this._launchVBS(vbsPath);
    return { success: true };
  }

  getStatus() {
    return {
      currentVersion: this.currentVersion,
      latestRelease: this.latestRelease,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      availableBackups: this._getBackups()
    };
  }

  signalStartupSuccess() {
    try {
      const flagData = JSON.stringify({ version: this.currentVersion, timestamp: new Date().toISOString(), pid: process.pid });
      fs.writeFileSync(this.flagPath, flagData, 'utf8');
      this._log('INFO', 'Startup success flag written', { version: this.currentVersion });
    } catch (error) {
      this._log('ERROR', 'Failed to write success flag', { error: error.message });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // VBS LAUNCHER — Job Object Escape via ShellExecuteEx
  // ═══════════════════════════════════════════════════════════════════

  _buildVBS(ps1Path) {
    // WScript.Shell.Run invokes ShellExecuteEx which creates processes
    // OUTSIDE the parent's Job Object. 0 = hidden window, False = don't wait.
    // In VBScript, "" inside a string literal produces a single "
    return [
      "'HammamPOS Updater Launcher v3.0",
      "'Escapes Electron Job Object via WScript.Shell.Run (ShellExecuteEx)",
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1Path}""", 0, False`,
      'Set sh = Nothing',
    ].join('\r\n') + '\r\n';
  }

  _launchVBS(vbsPath) {
    try {
      // cmd /c start uses ShellExecuteEx at the OS level
      execSync(`cmd /c start "" /b wscript.exe "${vbsPath}"`, {
        windowsHide: true,
        timeout: 10000
      });
      this._log('INFO', 'VBS launched via cmd start (ShellExecuteEx)', { vbsPath });
    } catch (e) {
      this._log('WARN', 'cmd start failed, trying direct wscript', { vbsPath, error: e.message });
      try {
        execSync(`wscript.exe "${vbsPath}"`, { windowsHide: true, timeout: 10000 });
        this._log('INFO', 'VBS launched via direct wscript', { vbsPath });
      } catch (e2) {
        this._log('ERROR', 'All launch methods failed', { vbsPath, error1: e.message, error2: e2.message });
        throw new Error('فشل إطلاق محدث التطبيق');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // POWERSHELL SCRIPT GENERATORS
  // ═══════════════════════════════════════════════════════════════════

  _buildUpdatePS1(zipPath, lockPath) {
    const logPath = path.join(this.logsDir, 'Updater.log');
    // In PowerShell single-quoted strings, ' must be escaped as ''
    const esc = (s) => s.replace(/'/g, "''");
    return `$ErrorActionPreference = 'Stop'
$installDir      = '${esc(this.installDir)}'
$stagingDir      = '${esc(this.stagingDir)}'
$oldDir          = '${esc(this.oldDir)}'
$oldPreviousDir  = '${esc(this.oldPreviousDir)}'
$flagPath        = '${esc(this.flagPath)}'
$statePath       = '${esc(this.statePath)}'
$logPath         = '${esc(logPath)}'
$zipPath         = '${esc(zipPath)}'
$lockPath        = '${esc(lockPath)}'
$exeName         = 'HammamPOS.exe'
$processTimeout  = 60
$handshakeTimeout = 90

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    try { Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}
function Write-State($stage) {
    try { @{stage=$stage;ts=(Get-Date -Format 'o');pid=$PID} | ConvertTo-Json | Set-Content $statePath -Encoding UTF8 } catch {}
}
function Abort($msg) {
    Write-Log "FATAL: $msg"
    Write-State "failed"
    if (-not (Test-Path $installDir) -and (Test-Path $oldDir)) {
        Write-Log "ROLLBACK: Restoring from backup..."
        try { Rename-Item $oldDir -NewName (Split-Path $installDir -Leaf) -Force; Write-Log "ROLLBACK OK" } catch { Write-Log "ROLLBACK FAILED: $_" }
    }
    $exe = Join-Path $installDir $exeName
    if (Test-Path $exe) { Start-Process $exe -ErrorAction SilentlyContinue }
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    exit 1
}

# Create lock file to prevent concurrent updates
Set-Content -Path $lockPath -Value "$PID" -Encoding UTF8 -ErrorAction SilentlyContinue

Write-Log "================================================================"
Write-Log "=== HAMMAMPOS UPDATE v3.0 STARTED ==="
Write-Log "================================================================"
Write-Log "PID: $PID | User: $env:USERNAME | Install: $installDir"
Write-State "started"

# ─── Step 1: Wait for HammamPOS to fully exit ────────────────────────
Write-Log "Step 1: Waiting for HammamPOS.exe to exit..."
$deadline = (Get-Date).AddSeconds($processTimeout)
$waited = 0
while ($true) {
    $procs = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
    if (-not $procs) { break }
    if ((Get-Date) -gt $deadline) {
        Write-Log "  Timeout. Force-killing..."
        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $still = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
        if ($still) { Abort "Cannot kill HammamPOS after $processTimeout sec" }
        break
    }
    if ($waited -gt 10) {
        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $waited++
}
Start-Sleep -Seconds 8
Write-Log "  Process exit confirmed."
Write-State "process_exited"

# ─── Step 2: Verify ZIP exists ───────────────────────────────────────
Write-Log "Step 2: Verifying ZIP..."
if (-not (Test-Path $zipPath)) { Abort "ZIP not found: $zipPath" }
$zipSize = (Get-Item $zipPath).Length
if ($zipSize -lt 1048576) { Abort "ZIP too small - $zipSize bytes - likely corrupt" }
Write-Log "  ZIP OK - $zipSize bytes"

# ─── Step 3: Extract to staging ──────────────────────────────────────
Write-Log "Step 3: Extracting to staging..."
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }
try {
    Expand-Archive -Path $zipPath -DestinationPath $stagingDir -Force
    # Allow filesystem + antivirus to finish scanning extracted files
    Start-Sleep -Seconds 3
    Write-Log "  Extraction complete."
} catch {
    Abort "Extraction failed: $($_.Exception.Message)"
}
Write-State "extracted"

# ─── Step 4: Verify staging integrity ────────────────────────────────
Write-Log "Step 4: Verifying staging..."
$exePath = Join-Path $stagingDir $exeName
$asarPath = Join-Path $stagingDir "resources\\app.asar"
if (-not (Test-Path $exePath)) { Abort "$exeName missing after extraction" }
if ((Get-Item $exePath).Length -eq 0) { Abort "$exeName is 0 bytes" }
if (-not (Test-Path $asarPath)) { Abort "resources\\app.asar missing" }
if ((Get-Item $asarPath).Length -eq 0) { Abort "resources\\app.asar is 0 bytes" }

# Verify files are not locked by AV (try to open for read)
try {
    $stream = [System.IO.File]::Open($exePath, 'Open', 'Read', 'Read')
    $stream.Close()
} catch {
    Write-Log "  EXE locked (likely AV scan). Waiting 5s..."
    Start-Sleep -Seconds 5
    try {
        $stream = [System.IO.File]::Open($exePath, 'Open', 'Read', 'Read')
        $stream.Close()
    } catch {
        Write-Log "  EXE still locked after wait: $($_.Exception.Message)"
        # Continue anyway — rename might still work since we're renaming the parent dir
    }
}

Write-Log "  Staging verified: exe=$((Get-Item $exePath).Length) asar=$((Get-Item $asarPath).Length)"
Write-State "verified"

# ─── Step 5: Manage backup lifecycle ─────────────────────────────────
Write-Log "Step 5: Managing backups..."
if (Test-Path $oldPreviousDir) {
    Write-Log "  Removing old-previous..."
    Remove-Item $oldPreviousDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep 1
}
if (Test-Path $oldDir) {
    Write-Log "  Promoting old -> old-previous..."
    try { Rename-Item $oldDir -NewName (Split-Path $oldPreviousDir -Leaf) -Force }
    catch {
        Write-Log "  Cannot promote, removing old..."
        Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep 1
    }
}
if (Test-Path $oldDir) { Abort "Cannot clear old backup dir" }
Write-Log "  Backup lifecycle OK."

# ─── Step 6: Atomic swap — rename install -> old ─────────────────────
Write-Log "Step 6: Rename install -> old..."
Write-State "swapping"
try {
    Rename-Item $installDir -NewName (Split-Path $oldDir -Leaf) -Force
    Write-Log "  install -> old OK"
} catch {
    Write-Log "  First attempt failed: $($_.Exception.Message)"
    Start-Sleep -Seconds 3
    try {
        Rename-Item $installDir -NewName (Split-Path $oldDir -Leaf) -Force
        Write-Log "  Retry succeeded."
    } catch {
        Abort "Cannot rename install to old: $($_.Exception.Message)"
    }
}

# ─── Step 7: Atomic swap — rename staging -> install ─────────────────
Write-Log "Step 7: Rename staging -> install..."
try {
    Rename-Item $stagingDir -NewName (Split-Path $installDir -Leaf) -Force
    Write-Log "  staging -> install OK"
} catch {
    Write-Log "CRITICAL: staging->install failed. Rolling back..."
    try { Rename-Item $oldDir -NewName (Split-Path $installDir -Leaf) -Force; Write-Log "  Rollback OK" }
    catch { Write-Log "  Rollback ALSO FAILED: $($_.Exception.Message)" }
    Abort "Cannot rename staging to install: $($_.Exception.Message)"
}
Write-State "swapped"
Write-Log "  === SWAP COMPLETE ==="

# ─── Step 8: Launch new version ──────────────────────────────────────
Write-Log "Step 8: Launching new version..."
$newExe = Join-Path $installDir $exeName
if (-not (Test-Path $newExe)) { Abort "New exe not found after swap: $newExe" }
Start-Process -FilePath $newExe
Write-State "launched"
Write-Log "  New process launched."

# ─── Step 9: Wait for success handshake ──────────────────────────────
Write-Log "Step 9: Waiting for handshake - $handshakeTimeout sec..."
$hDeadline = (Get-Date).AddSeconds($handshakeTimeout)
$handshake = $false
while ((Get-Date) -lt $hDeadline) {
    if (Test-Path $flagPath) { $handshake = $true; break }
    Start-Sleep -Seconds 1
}

if ($handshake) {
    Write-Log "  HANDSHAKE RECEIVED - Update successful!"
    Write-State "success"
    Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
    # Cleanup old-previous
    if (Test-Path $oldPreviousDir) { Remove-Item $oldPreviousDir -Recurse -Force -ErrorAction SilentlyContinue }
    # Cleanup downloaded ZIPs
    Get-ChildItem (Split-Path $zipPath) -Filter 'update-v*.zip' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
    Write-Log "  Cleanup complete."
} else {
    Write-Log "  WARNING: No handshake within $handshakeTimeout sec."
    Write-Log "  Backup preserved at: $oldDir"
    Write-Log "  User can revert from Settings."
    Write-State "no_handshake"
}

Write-Log "=== UPDATE FINISHED ==="
Write-Log "================================================================"

# Cleanup lock file + state + self
Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
try { Remove-Item $statePath -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2
try { Remove-Item $MyInvocation.MyCommand.Source -Force -ErrorAction SilentlyContinue } catch {}
`;
  }

  _buildRevertPS1() {
    const logPath = path.join(this.logsDir, 'Updater.log');
    const esc = (s) => s.replace(/'/g, "''");
    return `$ErrorActionPreference = 'Stop'
$installDir = '${esc(this.installDir)}'
$oldDir     = '${esc(this.oldDir)}'
$logPath    = '${esc(logPath)}'
$exeName    = 'HammamPOS.exe'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    try { Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}

Write-Log "================================================================"
Write-Log "=== HAMMAMPOS REVERT STARTED ==="
Write-Log "================================================================"

if (-not (Test-Path $oldDir)) {
    Write-Log "FATAL: No backup at $oldDir"
    exit 1
}

# Wait for app to exit
Write-Log "Waiting for HammamPOS to exit..."
$deadline = (Get-Date).AddSeconds(30)
while ($true) {
    $procs = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
    if (-not $procs) { break }
    if ((Get-Date) -gt $deadline) {
        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
        Start-Sleep 3
        break
    }
    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    Start-Sleep 1
}
Start-Sleep -Seconds 2

# Rename current -> removing
$removingDir = $installDir + '-removing'
if (Test-Path $removingDir) { Remove-Item $removingDir -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }

Write-Log "Renaming current -> removing..."
try { Rename-Item $installDir -NewName (Split-Path $removingDir -Leaf) -Force }
catch {
    Write-Log "FATAL: Cannot rename current: $($_.Exception.Message)"
    Start-Process (Join-Path $installDir $exeName) -ErrorAction SilentlyContinue
    exit 1
}

Write-Log "Renaming backup -> install..."
try { Rename-Item $oldDir -NewName (Split-Path $installDir -Leaf) -Force }
catch {
    Write-Log "FATAL: Cannot restore backup. Rolling back..."
    Rename-Item $removingDir -NewName (Split-Path $installDir -Leaf) -Force
    Start-Process (Join-Path $installDir $exeName) -ErrorAction SilentlyContinue
    exit 1
}

Write-Log "Launching reverted version..."
Start-Process (Join-Path $installDir $exeName)

Start-Sleep -Seconds 5
Remove-Item $removingDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Log "=== REVERT COMPLETE ==="
Start-Sleep 2
Remove-Item $MyInvocation.MyCommand.Source -Force -ErrorAction SilentlyContinue
`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STARTUP RECOVERY
  // ═══════════════════════════════════════════════════════════════════

  _startupRecovery() {
    // Clean abandoned staging
    try {
      if (fs.existsSync(this.stagingDir)) {
        fs.rmSync(this.stagingDir, { recursive: true, force: true });
      }
    } catch (_) {}

    // Recovery: if installDir is missing but oldDir exists, restore from backup
    // This handles the case where a reboot/crash happened between rename steps
    if (!fs.existsSync(this.installDir) && fs.existsSync(this.oldDir)) {
      this._log('WARN', 'Install dir missing but backup exists — auto-recovering');
      try {
        fs.renameSync(this.oldDir, this.installDir);
        this._log('INFO', 'Auto-recovery: restored from backup');
      } catch (e) {
        this._log('ERROR', 'Auto-recovery failed', { error: e.message });
      }
    }

    // Do NOT write success flag here — that is ONLY done by
    // signalStartupSuccess() called from main process after page loads.
    // Writing it here would falsely confirm a broken update.

    // Rotate log if > 1MB
    this._rotateLog();

    // Clean stale ZIPs older than 7 days
    this._cleanStaleZips();

    // Clean old VBS/PS1 launcher files
    try {
      const files = fs.readdirSync(this.updatesDir);
      for (const f of files) {
        if (f.endsWith('.vbs') || (f.startsWith('hammampos-') && f.endsWith('.ps1'))) {
          try { fs.unlinkSync(path.join(this.updatesDir, f)); } catch (_) {}
        }
      }
    } catch (_) {}

    // Clean stale lock file (older than 10 minutes = dead process)
    try {
      const lockPath = path.join(this.updatesDir, 'update.lock');
      if (fs.existsSync(lockPath)) {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 10 * 60 * 1000) {
          fs.unlinkSync(lockPath);
          this._log('INFO', 'Removed stale lock file');
        }
      }
    } catch (_) {}
  }

  _cleanStaleZips() {
    try {
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const files = fs.readdirSync(this.updatesDir);
      for (const file of files) {
        if (!file.endsWith('.zip')) continue;
        const filePath = path.join(this.updatesDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sevenDaysAgo) fs.unlinkSync(filePath);
      }
    } catch (_) {}
  }

  _rotateLog() {
    try {
      const logFile = path.join(this.logsDir, 'Updater.log');
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size > 1024 * 1024) { // > 1MB
        // Keep last 500KB
        const content = fs.readFileSync(logFile, 'utf8');
        const trimmed = content.slice(-512 * 1024);
        const marker = `\n[${new Date().toISOString()}] [INFO] === LOG ROTATED (was ${stat.size} bytes) ===\n`;
        fs.writeFileSync(logFile, marker + trimmed, 'utf8');
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _resolveInstallDir() {
    const execDir = path.dirname(process.execPath);
    const execName = path.basename(process.execPath).toLowerCase();
    if (execName === 'hammampos.exe') return execDir;
    return 'C:\\HammamPOS';
  }

  _getBackups() {
    const backups = [];
    if (fs.existsSync(this.oldDir)) {
      backups.push({ version: 'previous', available: true, path: this.oldDir });
    }
    return backups;
  }

  _log(level, message, data = null) {
    try {
      const ts = new Date().toISOString();
      let entry = `[${ts}] [${level}] ${message}`;
      if (data) entry += ' ' + JSON.stringify(data);
      entry += '\n';
      fs.appendFileSync(path.join(this.logsDir, 'Updater.log'), entry, 'utf8');
    } catch (_) {}
  }

  _setState(stage, extra = {}) {
    try {
      const state = { stage, timestamp: new Date().toISOString(), currentVersion: this.currentVersion, targetVersion: this.latestRelease ? this.latestRelease.version : null, ...extra };
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {}
  }

  _isNewer(remote, local) {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true;
      if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // NETWORK
  // ═══════════════════════════════════════════════════════════════════

  async fetchAllReleases() {
    try {
      const releases = await this._fetchReleasesList();
      if (!releases || !Array.isArray(releases)) return [];
      return releases
        .filter(r => r.assets && r.assets.some(a => a.name.endsWith('.zip')))
        .map(r => ({
          version: r.tag_name.replace(/^v/, ''),
          tag: r.tag_name,
          notes: r.body || '',
          date: r.published_at || r.created_at,
        }));
    } catch (e) {
      this._log('ERROR', 'Failed to fetch releases list', { error: e.message });
      return [];
    }
  }

  async downloadAndInstallVersion(version) {
    const releases = await this._fetchReleasesList();
    const release = releases.find(r => r.tag_name === `v${version}` || r.tag_name === version);
    if (!release) throw new Error(`الإصدار v${version} غير موجود`);
    const zipAsset = release.assets.find(a => a.name.endsWith('.zip'));
    if (!zipAsset) throw new Error(`لا يوجد ملف ZIP للإصدار v${version}`);

    // Download
    this.latestRelease = { version, tag: release.tag_name, notes: release.body || '', downloadUrl: zipAsset.browser_download_url, size: zipAsset.size };
    const zipPath = path.join(this.updatesDir, `update-v${version}.zip`);
    this._log('INFO', 'Downloading specific version', { version, url: zipAsset.browser_download_url });
    await this._download(zipAsset.browser_download_url, zipPath);

    // Validate
    const actualSize = fs.statSync(zipPath).size;
    if (actualSize < 1024 * 1024) throw new Error('ملف ZIP صغير جداً');

    this._log('INFO', 'Version download complete', { version, size: actualSize });

    // Apply using the standard flow
    return this.applyAndRestart();
  }

  _fetchReleasesList() {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
    return new Promise((resolve, reject) => {
      const options = { headers: { 'User-Agent': 'HammamPOS-Updater' }, timeout: 15000 };
      const follow = (reqUrl, depth) => {
        if (depth > 5) return reject(new Error('Too many redirects'));
        https.get(reqUrl, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return follow(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
      };
      follow(url, 0);
    });
  }

  _fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = { headers: { 'User-Agent': 'HammamPOS-Updater' }, timeout: 15000 };
      const follow = (url, depth) => {
        if (depth > 5) return reject(new Error('Too many redirects'));
        https.get(url, options, (res) => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return follow(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
      };
      follow(RELEASES_API, 0);
    });
  }

  _download(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let totalSize = this.latestRelease ? this.latestRelease.size : 0;
      let downloaded = 0;
      let redirects = 0;

      const get = (reqUrl) => {
        if (++redirects > 10) {
          file.close();
          try { fs.unlinkSync(dest); } catch (_) {}
          return reject(new Error('Too many redirects'));
        }
        const options = { headers: { 'User-Agent': 'HammamPOS-Updater' }, timeout: 120000 };
        https.get(reqUrl, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return get(res.headers.location);
          }
          if (res.statusCode !== 200) {
            file.close();
            try { fs.unlinkSync(dest); } catch (_) {}
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          if (res.headers['content-length']) totalSize = parseInt(res.headers['content-length'], 10);
          res.on('data', chunk => {
            downloaded += chunk.length;
            this.downloadProgress = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
          });
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', err => { file.close(); reject(err); });
        }).on('error', err => {
          file.close();
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      };
      get(url);
    });
  }
}

module.exports = UpdateManager;
