/**
 * HammamPOS - UpdateManager (Production v2.3.1)
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * ARCHITECTURE: Rename-Swap with Success Handshake
 * =================================================
 *
 * 1. Download ZIP → %APPDATA%\HammamPOS\updates\
 * 2. Extract to C:\HammamPOS-update\ (staging)
 * 3. Verify integrity (file size, exe, app.asar)
 * 4. Spawn PowerShell updater from %TEMP%
 * 5. Updater:
 *    a) Kill legacy cmd.exe (apply.bat orphans)
 *    b) Kill all HammamPOS.exe
 *    c) Remove stale C:\HammamPOS-old-previous (two generations back)
 *    d) Rename C:\HammamPOS-old → C:\HammamPOS-old-previous (preserve last backup)
 *    e) Rename C:\HammamPOS → C:\HammamPOS-old (create new backup)
 *    f) Rename C:\HammamPOS-update → C:\HammamPOS (install)
 *    g) Launch new exe
 *    h) Wait for success handshake (%APPDATA%\HammamPOS\update-success.flag)
 *    i) If handshake received: delete old-previous, cleanup
 *    j) If handshake NOT received: keep old dir intact, log failure
 *
 * PATHS:
 *   Install:    C:\HammamPOS\
 *   Staging:    C:\HammamPOS-update\
 *   Backup:     C:\HammamPOS-old\
 *   OldBackup:  C:\HammamPOS-old-previous\
 *   Data:       %APPDATA%\HammamPOS\           (database, NEVER touched)
 *   Downloads:  %APPDATA%\HammamPOS\updates\
 *   Logs:       %APPDATA%\HammamPOS\Logs\
 *   Flag:       %APPDATA%\HammamPOS\update-success.flag
 *   Script:     %TEMP%\hammampos-updater.ps1
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const GITHUB_OWNER = 'alijaouhari';
const GITHUB_REPO = 'hammampos';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

class UpdateManager {
  constructor() {
    this.currentVersion = require('../../package.json').version;
    // Dynamic install path based on where the exe is actually running from
    this.installDir = this._resolveInstallDir();
    this.stagingDir = this.installDir + '-update';
    this.oldDir = this.installDir + '-old';
    this.oldPreviousDir = this.installDir + '-old-previous';
    this.dataDir = path.join(process.env.APPDATA, 'HammamPOS');
    this.updatesDir = path.join(this.dataDir, 'updates');
    this.logsDir = path.join(this.dataDir, 'Logs');
    this.flagPath = path.join(this.dataDir, 'update-success.flag');
    this.latestRelease = null;
    this.downloadProgress = 0;
    this.isDownloading = false;

    // Ensure directories exist
    [this.updatesDir, this.logsDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // Startup: clean staging leftovers + write success flag if needed
    this._startupRecovery();
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────

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

    this._log('INFO', 'Download started', {
      version: this.latestRelease.version,
      url: this.latestRelease.downloadUrl,
      expectedSize: this.latestRelease.size
    });

    try {
      await this._download(this.latestRelease.downloadUrl, zipPath);

      // Verify download size
      const actualSize = fs.statSync(zipPath).size;
      if (this.latestRelease.size && Math.abs(actualSize - this.latestRelease.size) > 1024) {
        throw new Error(`حجم الملف غير صحيح: متوقع ${this.latestRelease.size}, فعلي ${actualSize}`);
      }
      this._log('INFO', 'Download complete', { size: actualSize });

      // Extract to staging
      this._log('INFO', 'Extraction started', { destination: this.stagingDir });
      this._extractToStaging(zipPath);
      this._log('INFO', 'Extraction complete');

      // Verify integrity
      this._verifyStaging();
      this._log('INFO', 'Verification passed');

      this.isDownloading = false;
      return { success: true };
    } catch (error) {
      this.isDownloading = false;
      this._log('ERROR', 'Download/extract failed', { error: error.message });
      this._cleanupStaging();
      try { fs.unlinkSync(zipPath); } catch (_) {}
      throw error;
    }
  }

  applyAndRestart() {
    if (!fs.existsSync(this.stagingDir)) {
      throw new Error('ملف التحديث غير موجود. أعد التحميل.');
    }
    if (!fs.existsSync(path.join(this.stagingDir, 'HammamPOS.exe'))) {
      throw new Error('ملف التحديث تالف. أعد التحميل.');
    }

    // Remove any stale success flag
    try { fs.unlinkSync(this.flagPath); } catch (_) {}

    this._log('INFO', 'Apply started', {
      currentVersion: this.currentVersion,
      targetVersion: this.latestRelease ? this.latestRelease.version : 'unknown'
    });

    this._launchSwapScript();
    return { success: true };
  }

  revertAndRestart() {
    if (!fs.existsSync(this.oldDir)) {
      throw new Error('لا توجد نسخة سابقة للرجوع إليها');
    }

    this._log('INFO', 'Revert initiated');
    this._launchRevertScript();
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

  /**
   * Called by main process after app is fully initialized and ready.
   * Writes the success handshake flag so the updater script knows the launch worked.
   */
  signalStartupSuccess() {
    try {
      const flagData = JSON.stringify({
        version: this.currentVersion,
        timestamp: new Date().toISOString(),
        pid: process.pid
      });
      fs.writeFileSync(this.flagPath, flagData, 'utf8');
      this._log('INFO', 'Startup success flag written', { version: this.currentVersion });
    } catch (error) {
      this._log('ERROR', 'Failed to write success flag', { error: error.message });
    }
  }

  // ─── STAGING ────────────────────────────────────────────────────────

  _extractToStaging(zipPath) {
    this._cleanupStaging();

    const { execSync } = require('child_process');
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${this.stagingDir}'"`,
      { timeout: 120000 }
    );
  }

  _verifyStaging() {
    const requiredFiles = ['HammamPOS.exe', path.join('resources', 'app.asar')];
    for (const file of requiredFiles) {
      const fullPath = path.join(this.stagingDir, file);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`ملف مفقود بعد الاستخراج: ${file}`);
      }
      const stat = fs.statSync(fullPath);
      if (stat.size === 0) {
        throw new Error(`ملف فارغ بعد الاستخراج: ${file}`);
      }
    }
  }

  // ─── SWAP SCRIPT ────────────────────────────────────────────────────

  _launchSwapScript() {
    const scriptPath = path.join(os.tmpdir(), 'hammampos-updater.ps1');
    const logPath = path.join(this.logsDir, 'Updater.log').replace(/\\/g, '\\\\');

    const ps1 = `
$ErrorActionPreference = 'Stop'
$installDir = '${this.installDir}'
$stagingDir = '${this.stagingDir}'
$oldDir = '${this.oldDir}'
$oldPreviousDir = '${this.oldPreviousDir}'
$flagPath = '${this.flagPath}'
$logPath = '${logPath}'
$exeName = 'HammamPOS.exe'
$handshakeTimeout = 30

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $entry = "[$ts] $msg"
    Add-Content -Path $logPath -Value $entry -ErrorAction SilentlyContinue
}

Write-Log "=== UPDATE STARTED ==="
Write-Log "Install: $installDir"
Write-Log "Staging: $stagingDir"

# --- Step 1: Kill orphaned cmd.exe running legacy apply.bat ---
Write-Log "Killing legacy cmd.exe (apply.bat)..."
try {
    Get-WmiObject Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -match 'apply\\.bat') {
            Write-Log "  Killing cmd.exe PID $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Log "  WMI query failed (non-critical): $_"
}

# --- Step 2: Kill all HammamPOS processes ---
Write-Log "Killing HammamPOS processes..."
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$remaining = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
if ($remaining) {
    Write-Log "  WARNING: Processes still alive after kill: $($remaining.Count)"
    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}
Write-Log "Processes terminated."

# --- Step 3: Manage backup lifecycle ---
# Remove two-generations-back backup
if (Test-Path $oldPreviousDir) {
    Write-Log "Removing old-previous backup..."
    Remove-Item -Path $oldPreviousDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Promote current backup to old-previous (preserve one generation)
if (Test-Path $oldDir) {
    Write-Log "Promoting old backup to old-previous..."
    try {
        Rename-Item -Path $oldDir -NewName (Split-Path $oldPreviousDir -Leaf) -Force
    } catch {
        Write-Log "  Could not promote backup: $_. Removing instead."
        Remove-Item -Path $oldDir -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

# Verify old dir is gone before proceeding
if (Test-Path $oldDir) {
    Write-Log "FATAL: Cannot clear old backup directory. Aborting."
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# --- Step 4: Rename current → old (create backup) ---
Write-Log "Renaming install -> old..."
try {
    Rename-Item -Path $installDir -NewName (Split-Path $oldDir -Leaf) -Force
    Write-Log "  Rename succeeded."
} catch {
    $err = $_.Exception.Message
    Write-Log "FATAL: Rename install->old failed: $err"

    # Targeted recovery: try killing any process that holds a lock
    Write-Log "  Attempting targeted recovery..."
    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    Get-WmiObject Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -match 'apply\\.bat|HammamPOS') {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 3

    # Single retry
    try {
        Rename-Item -Path $installDir -NewName (Split-Path $oldDir -Leaf) -Force
        Write-Log "  Retry succeeded."
    } catch {
        Write-Log "FATAL: Retry failed: $($_.Exception.Message). Aborting."
        Start-Process -FilePath (Join-Path $installDir $exeName)
        exit 1
    }
}

# --- Step 5: Rename staging → install ---
Write-Log "Renaming staging -> install..."
try {
    Rename-Item -Path $stagingDir -NewName (Split-Path $installDir -Leaf) -Force
    Write-Log "  Rename succeeded."
} catch {
    $err = $_.Exception.Message
    Write-Log "FATAL: Rename staging->install failed: $err. Rolling back."
    # ROLLBACK: restore old → install
    Rename-Item -Path $oldDir -NewName (Split-Path $installDir -Leaf) -Force
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# --- Step 6: Launch new version ---
Write-Log "Launching new version..."
Start-Process -FilePath (Join-Path $installDir $exeName)

# --- Step 7: Wait for success handshake ---
Write-Log "Waiting for handshake (max ${handshakeTimeout}s)..."
$deadline = (Get-Date).AddSeconds($handshakeTimeout)
$handshakeReceived = $false

while ((Get-Date) -lt $deadline) {
    if (Test-Path $flagPath) {
        $handshakeReceived = $true
        break
    }
    Start-Sleep -Seconds 1
}

if ($handshakeReceived) {
    Write-Log "Handshake received. Update successful."
    # Remove flag
    Remove-Item -Path $flagPath -Force -ErrorAction SilentlyContinue
    # Clean old-previous (safe to delete now — old is the rollback)
    if (Test-Path $oldPreviousDir) {
        Remove-Item -Path $oldPreviousDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Clean downloaded ZIP
    Get-ChildItem -Path (Join-Path $env:APPDATA 'HammamPOS\\updates') -Filter 'update-v*.zip' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
    }
    Write-Log "Cleanup complete."
} else {
    Write-Log "WARNING: Handshake NOT received within ${handshakeTimeout}s."
    Write-Log "  Keeping backup intact for manual rollback."
    Write-Log "  The new version may have failed to start."
}

Write-Log "=== UPDATE FINISHED ==="

# --- Self-delete ---
Start-Sleep -Seconds 2
Remove-Item -Path $MyInvocation.MyCommand.Source -Force -ErrorAction SilentlyContinue
`;

    fs.writeFileSync(scriptPath, ps1.trim(), 'utf8');

    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir()
    }).unref();

    this._log('INFO', 'Updater script launched', { path: scriptPath });
  }

  _launchRevertScript() {
    const scriptPath = path.join(os.tmpdir(), 'hammampos-revert.ps1');
    const logPath = path.join(this.logsDir, 'Updater.log').replace(/\\/g, '\\\\');

    const ps1 = `
$ErrorActionPreference = 'Stop'
$installDir = '${this.installDir}'
$oldDir = '${this.oldDir}'
$logPath = '${logPath}'
$exeName = 'HammamPOS.exe'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logPath -Value "[$ts] $msg" -ErrorAction SilentlyContinue
}

Write-Log "=== REVERT STARTED ==="

if (-not (Test-Path $oldDir)) {
    Write-Log "FATAL: No backup found at $oldDir"
    exit 1
}

# Kill app
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Rename current → removing
$removingDir = $installDir + '-removing'
if (Test-Path $removingDir) { Remove-Item -Path $removingDir -Recurse -Force -ErrorAction SilentlyContinue }

try {
    Rename-Item -Path $installDir -NewName (Split-Path $removingDir -Leaf) -Force
} catch {
    Write-Log "FATAL: Cannot rename current install: $($_.Exception.Message)"
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# Rename old → install
try {
    Rename-Item -Path $oldDir -NewName (Split-Path $installDir -Leaf) -Force
} catch {
    Write-Log "FATAL: Cannot rename backup to install: $($_.Exception.Message). Rolling back."
    Rename-Item -Path $removingDir -NewName (Split-Path $installDir -Leaf) -Force
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# Launch reverted version
Start-Process -FilePath (Join-Path $installDir $exeName)

# Cleanup
Start-Sleep -Seconds 5
Remove-Item -Path $removingDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Log "=== REVERT COMPLETE ==="
Remove-Item -Path $MyInvocation.MyCommand.Source -Force -ErrorAction SilentlyContinue
`;

    fs.writeFileSync(scriptPath, ps1.trim(), 'utf8');

    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir()
    }).unref();

    this._log('INFO', 'Revert script launched');
  }

  // ─── STARTUP RECOVERY ───────────────────────────────────────────────

  _startupRecovery() {
    // Clean abandoned staging directory
    this._cleanupStaging();

    // Write success flag on startup (signals to any waiting updater that we launched OK)
    // This is also called explicitly by main process via signalStartupSuccess()
    // but we do it here too as a safety net
    this.signalStartupSuccess();

    // Clean stale ZIPs older than 7 days
    this._cleanStaleZips();
  }

  _cleanupStaging() {
    try {
      if (fs.existsSync(this.stagingDir)) {
        fs.rmSync(this.stagingDir, { recursive: true, force: true });
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
        if (stat.mtimeMs < sevenDaysAgo) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (_) {}
  }

  // ─── HELPERS ────────────────────────────────────────────────────────

  _resolveInstallDir() {
    // In production (packaged), process.execPath = C:\HammamPOS\HammamPOS.exe
    // In development (node or electron via node_modules), fall back to hardcoded
    const execDir = path.dirname(process.execPath);
    const execName = path.basename(process.execPath).toLowerCase();
    if (execName === 'hammampos.exe') {
      return execDir;
    }
    // Development mode — use hardcoded path
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
      const logFile = path.join(this.logsDir, 'Updater.log');
      fs.appendFileSync(logFile, entry, 'utf8');
    } catch (_) {}
  }

  // ─── NETWORK ────────────────────────────────────────────────────────

  _fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        headers: { 'User-Agent': 'HammamPOS-Updater' },
        timeout: 15000
      };

      https.get(RELEASES_API, options, (res) => {
        if (res.statusCode === 404) return resolve(null);

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, options, (res2) => {
            let data = '';
            res2.on('data', chunk => { data += chunk; });
            res2.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
          return;
        }

        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  _download(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let totalSize = this.latestRelease ? this.latestRelease.size : 0;
      let downloaded = 0;

      const get = (reqUrl) => {
        const options = {
          headers: { 'User-Agent': 'HammamPOS-Updater' },
          timeout: 120000
        };

        https.get(reqUrl, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return get(res.headers.location);
          }

          if (res.statusCode !== 200) {
            file.close();
            try { fs.unlinkSync(dest); } catch (_) {}
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          if (res.headers['content-length']) {
            totalSize = parseInt(res.headers['content-length'], 10);
          }

          res.on('data', chunk => {
            downloaded += chunk.length;
            this.downloadProgress = totalSize > 0
              ? Math.round((downloaded / totalSize) * 100)
              : 0;
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

  // ─── UTIL ───────────────────────────────────────────────────────────

  _isNewer(remote, local) {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true;
      if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
  }
}

module.exports = UpdateManager;
