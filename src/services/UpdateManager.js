/**
 * HammamPOS - UpdateManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * HOW PROFESSIONAL DESKTOP APPS UPDATE ON WINDOWS
 * ================================================
 *
 * Problem: Windows locks .exe, .dll, .asar, .pak files while they're in use.
 * You CANNOT overwrite them. Expand-Archive fails. Copy fails. Nothing works
 * while the app (or any child process) is running from that directory.
 *
 * Solution (same as VS Code, Chrome, Discord):
 * 1. Download ZIP to a staging area (%APPDATA%\HammamPOS\updates\)
 * 2. Extract ZIP to a FRESH directory (C:\HammamPOS-update\) — no conflicts
 * 3. Spawn a PowerShell script from %TEMP% that:
 *    a) Kills ALL HammamPOS.exe processes
 *    b) RENAMES C:\HammamPOS → C:\HammamPOS-old  (instant, works even with locks releasing)
 *    c) RENAMES C:\HammamPOS-update → C:\HammamPOS (instant)
 *    d) Starts C:\HammamPOS\HammamPOS.exe
 *    e) Deletes C:\HammamPOS-old on success
 *
 * Why RENAME instead of overwrite:
 * - Rename is an atomic filesystem operation
 * - Windows allows renaming a directory even if handles are releasing
 * - No file-by-file extraction over locked files
 * - If rename fails, nothing is corrupted — old install is untouched
 * - Rollback is trivial: rename back
 *
 * Paths:
 *   Install:   C:\HammamPOS\                (active app)
 *   Staging:   C:\HammamPOS-update\         (extracted new version, temporary)
 *   Old:       C:\HammamPOS-old\            (previous version after swap, deleted on success)
 *   Data:      %APPDATA%\HammamPOS\         (database — NEVER touched)
 *   Downloads: %APPDATA%\HammamPOS\updates\ (ZIP downloads, backup metadata)
 *   Script:    %TEMP%\hammampos-updater.ps1 (self-deleting)
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
    this.installDir = 'C:\\HammamPOS';
    this.stagingDir = 'C:\\HammamPOS-update';
    this.oldDir = 'C:\\HammamPOS-old';
    this.dataDir = path.join(process.env.APPDATA, 'HammamPOS');
    this.updatesDir = path.join(this.dataDir, 'updates');
    this.latestRelease = null;
    this.downloadProgress = 0;
    this.isDownloading = false;

    if (!fs.existsSync(this.updatesDir)) {
      fs.mkdirSync(this.updatesDir, { recursive: true });
    }

    // Clean up any leftover staging/old dirs from interrupted updates
    this._cleanupLeftovers();
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
      console.warn('Update check failed:', error.message);
      return null;
    }
  }

  async downloadUpdate() {
    if (!this.latestRelease) throw new Error('لا يوجد تحديث');
    if (this.isDownloading) throw new Error('التحميل جاري بالفعل');

    this.isDownloading = true;
    this.downloadProgress = 0;

    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);

    try {
      // Download the ZIP
      await this._download(this.latestRelease.downloadUrl, zipPath);

      // Extract to staging directory (fresh, no conflicts possible)
      this._extractToStaging(zipPath);

      this.isDownloading = false;
      return { success: true };
    } catch (error) {
      this.isDownloading = false;
      this._cleanupLeftovers();
      try { fs.unlinkSync(zipPath); } catch (_) {}
      throw error;
    }
  }

  applyAndRestart() {
    // Verify staging dir exists (download was successful)
    if (!fs.existsSync(this.stagingDir)) {
      throw new Error('ملف التحديث غير موجود. أعد التحميل.');
    }

    // Verify the exe exists in staging
    const stagedExe = path.join(this.stagingDir, 'HammamPOS.exe');
    if (!fs.existsSync(stagedExe)) {
      throw new Error('ملف التحديث تالف. أعد التحميل.');
    }

    // Write and launch the swap script
    this._launchSwapScript();
    return { success: true };
  }

  revertAndRestart() {
    // Check if old dir exists (previous version kept after last update)
    if (!fs.existsSync(this.oldDir)) {
      throw new Error('لا توجد نسخة سابقة للرجوع إليها');
    }

    // Write a script that swaps back: current → delete, old → current
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

  // ─── STAGING: EXTRACT TO FRESH DIRECTORY ────────────────────────────

  _extractToStaging(zipPath) {
    // Remove any previous staging dir
    if (fs.existsSync(this.stagingDir)) {
      fs.rmSync(this.stagingDir, { recursive: true, force: true });
    }

    // Extract to a completely fresh directory — no locked files, no conflicts
    const { execSync } = require('child_process');
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${this.stagingDir}'"`,
      { timeout: 120000 }
    );

    // Verify extraction worked
    if (!fs.existsSync(path.join(this.stagingDir, 'HammamPOS.exe'))) {
      throw new Error('فشل استخراج التحديث');
    }
  }

  // ─── SWAP SCRIPT: THE ACTUAL UPDATE MECHANISM ───────────────────────

  /**
   * Creates a PowerShell script in %TEMP% that:
   * 1. Kills all HammamPOS processes
   * 2. Waits for file locks to release (bounded, not infinite)
   * 3. Renames C:\HammamPOS → C:\HammamPOS-old
   * 4. Renames C:\HammamPOS-update → C:\HammamPOS
   * 5. Launches the new exe
   * 6. Cleans up
   *
   * If ANY step fails, it rolls back (renames old back to current).
   */
  _launchSwapScript() {
    const scriptPath = path.join(os.tmpdir(), 'hammampos-updater.ps1');

    const ps1 = `
$ErrorActionPreference = 'Stop'
$installDir = '${this.installDir}'
$stagingDir = '${this.stagingDir}'
$oldDir = '${this.oldDir}'
$exeName = 'HammamPOS.exe'

# --- Step 1: Kill all HammamPOS processes ---
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Kill again (Electron child processes can linger)
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# --- Step 2: Remove leftover old dir if it exists ---
if (Test-Path $oldDir) {
    Remove-Item -Path $oldDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# --- Step 3: Rename current install → old ---
$retries = 0
$maxRetries = 10
$renamed = $false
while (-not $renamed -and $retries -lt $maxRetries) {
    try {
        Rename-Item -Path $installDir -NewName 'HammamPOS-old' -Force
        $renamed = $true
    } catch {
        $retries++
        # Kill any remaining processes that might hold locks
        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

if (-not $renamed) {
    # FAILED — cannot rename. Abort. App is still intact.
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# --- Step 4: Rename staging → install ---
try {
    Rename-Item -Path $stagingDir -NewName 'HammamPOS' -Force
} catch {
    # ROLLBACK: rename old back
    Rename-Item -Path $oldDir -NewName 'HammamPOS' -Force
    Start-Process -FilePath (Join-Path $installDir $exeName)
    exit 1
}

# --- Step 5: Launch the new version ---
Start-Process -FilePath (Join-Path $installDir $exeName)

# --- Step 6: Delete old version (non-critical) ---
Start-Sleep -Seconds 5
Remove-Item -Path $oldDir -Recurse -Force -ErrorAction SilentlyContinue

# --- Step 7: Self-delete ---
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
  }

  _launchRevertScript() {
    const scriptPath = path.join(os.tmpdir(), 'hammampos-revert.ps1');

    const ps1 = `
$ErrorActionPreference = 'Stop'
$installDir = '${this.installDir}'
$oldDir = '${this.oldDir}'
$exeName = 'HammamPOS.exe'

# Kill app
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Remove current
$retries = 0
$removed = $false
while (-not $removed -and $retries -lt 10) {
    try {
        Remove-Item -Path $installDir -Recurse -Force
        $removed = $true
    } catch {
        $retries++
        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

if (-not $removed) {
    # Can't remove current, try rename approach
    $tempName = $installDir + '-removing'
    Rename-Item -Path $installDir -NewName (Split-Path $tempName -Leaf) -Force
    Start-Sleep -Seconds 1
}

# Move old → current
Rename-Item -Path $oldDir -NewName 'HammamPOS' -Force

# Launch
Start-Process -FilePath (Join-Path $installDir $exeName)

# Cleanup
Start-Sleep -Seconds 3
$tempDir = $installDir + '-removing'
if (Test-Path $tempDir) { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
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
  }

  // ─── HELPERS ────────────────────────────────────────────────────────

  _cleanupLeftovers() {
    try {
      if (fs.existsSync(this.stagingDir)) {
        fs.rmSync(this.stagingDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  _getBackups() {
    // "Backup" is now just whether the old dir exists
    if (fs.existsSync(this.oldDir)) {
      try {
        const pkg = path.join(this.oldDir, 'resources', 'app.asar');
        return [{ version: 'previous', available: true }];
      } catch (_) {}
    }
    return [];
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

        // Handle redirects
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
          // Follow redirects (GitHub releases redirect to S3)
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
