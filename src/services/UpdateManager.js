/**
 * HammamPOS - UpdateManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * Self-update system for HammamPOS desktop application.
 *
 * ARCHITECTURE:
 *   Problem: A running Electron app on Windows locks its own .exe and .asar files.
 *            Multiple child processes (main, GPU, renderer, utility) all named
 *            HammamPOS.exe stay alive even after app.exit().
 *
 *   Solution: A PowerShell script copied to %TEMP% (outside the install dir, never locked).
 *            The script uses Get-Process/Stop-Process/Wait-Process — reliable Windows
 *            process management APIs — instead of fragile tasklist|find batch piping.
 *            No infinite loops. Hard 15-second timeout. Retry on extraction failure.
 *
 * FLOW:
 *   1. checkForUpdate()   → compare local version to GitHub Releases latest tag
 *   2. downloadUpdate()   → download ZIP to %APPDATA%\HammamPOS\updates\, backup current
 *   3. applyAndRestart()  → write PS1 to %TEMP%, spawn it detached, caller exits app
 *   4. [PowerShell script] → kill ALL HammamPOS.exe, wait for file locks, extract, relaunch
 *
 * PATHS:
 *   Install:  C:\HammamPOS\                   (exe, asar, DLLs — overwritten by updates)
 *   Data:     %APPDATA%\HammamPOS\            (database — NEVER touched by updates)
 *   Updates:  %APPDATA%\HammamPOS\updates\    (downloaded ZIPs, backups)
 *   Script:   %TEMP%\hammampos-update.ps1     (self-deleting after success)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const GITHUB_OWNER = 'alijaouhari';
const GITHUB_REPO = 'hammampos';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

class UpdateManager {
  constructor() {
    this.currentVersion = require('../../package.json').version;
    this.installDir = path.dirname(process.execPath);
    this.dataDir = path.join(process.env.APPDATA || process.env.HOME, 'HammamPOS');
    this.updatesDir = path.join(this.dataDir, 'updates');
    this.latestRelease = null;
    this.downloadProgress = 0;
    this.isDownloading = false;

    if (!fs.existsSync(this.updatesDir)) {
      fs.mkdirSync(this.updatesDir, { recursive: true });
    }
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────

  async checkForUpdate() {
    try {
      const release = await this._fetchJSON(RELEASES_API);
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
    if (!this.latestRelease) throw new Error('No update available');
    if (this.isDownloading) throw new Error('Download already in progress');

    this.isDownloading = true;
    this.downloadProgress = 0;

    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);

    try {
      await this._downloadFile(this.latestRelease.downloadUrl, zipPath);
      this._backupCurrentInstall();
      this.isDownloading = false;
      return { success: true };
    } catch (error) {
      this.isDownloading = false;
      try { fs.unlinkSync(zipPath); } catch (_) {}
      throw error;
    }
  }

  /**
   * Launch the updater script and return. Caller MUST exit the app immediately after.
   */
  applyAndRestart() {
    if (!this.latestRelease) throw new Error('No update available');

    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error('Update ZIP not found');

    this._launchUpdater(zipPath);
    return { success: true };
  }

  /**
   * Revert to previous version. Caller MUST exit the app immediately after.
   */
  revertAndRestart() {
    const backups = this._getBackups();
    if (backups.length === 0) throw new Error('لا توجد نسخة سابقة للرجوع إليها');

    this._launchUpdater(backups[0].path);
    return { success: true, revertedTo: backups[0].version };
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

  // ─── CORE: POWERSHELL UPDATER ───────────────────────────────────────

  /**
   * Writes a self-contained PowerShell script to %TEMP% and spawns it detached.
   *
   * Why PowerShell from %TEMP%:
   *   - %TEMP% is outside the install dir — the script is never locked
   *   - Get-Process/Stop-Process are proper Windows APIs (not tasklist|find piping)
   *   - Wait-Process with -Timeout prevents infinite loops
   *   - Expand-Archive handles ZIP extraction natively
   *   - -WindowStyle Hidden makes it invisible to the user
   *   - try/catch gives real error handling
   */
  _launchUpdater(zipPath) {
    const scriptPath = path.join(os.tmpdir(), 'hammampos-update.ps1');
    const exePath = path.join(this.installDir, 'HammamPOS.exe');

    // Escape single quotes for PowerShell string literals
    const esc = (s) => s.replace(/'/g, "''");

    const ps1 = [
      '# HammamPOS Updater — generated by UpdateManager',
      '# Runs from %TEMP%, fully independent of the app',
      '$ErrorActionPreference = "Continue"',
      '',
      `$zipPath = '${esc(zipPath)}'`,
      `$installDir = '${esc(this.installDir)}'`,
      `$exePath = '${esc(exePath)}'`,
      '',
      '# Step 1: Kill ALL HammamPOS processes (main + GPU + renderer + utility)',
      '$procs = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue',
      'if ($procs) {',
      '    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue',
      '    # Wait up to 15 seconds for all processes to die',
      '    $deadline = (Get-Date).AddSeconds(15)',
      '    do {',
      '        Start-Sleep -Milliseconds 500',
      '        $remaining = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue',
      '        if (-not $remaining) { break }',
      '        Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue',
      '    } while ((Get-Date) -lt $deadline)',
      '}',
      '',
      '# Step 2: Wait 3 seconds for Windows to release file locks',
      'Start-Sleep -Seconds 3',
      '',
      '# Step 3: Extract ZIP over install directory',
      'try {',
      '    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force',
      '} catch {',
      '    # Retry once after 5 more seconds (file locks can linger)',
      '    Start-Sleep -Seconds 5',
      '    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force',
      '}',
      '',
      '# Step 4: Relaunch the app',
      'Start-Process -FilePath $exePath',
      '',
      '# Step 5: Clean up — delete this script',
      'Start-Sleep -Seconds 2',
      'Remove-Item -Path $MyInvocation.MyCommand.Source -Force -ErrorAction SilentlyContinue',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, ps1, 'utf8');

    // Spawn PowerShell detached — it outlives this process
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

  // ─── BACKUP ─────────────────────────────────────────────────────────

  _backupCurrentInstall() {
    const backupPath = path.join(this.updatesDir, `backup-v${this.currentVersion}.zip`);
    if (fs.existsSync(backupPath)) return;

    execSync(
      `powershell -Command "Compress-Archive -Path '${this.installDir}\\*' -DestinationPath '${backupPath}' -Force"`,
      { timeout: 180000 }
    );

    // Keep only 2 most recent backups
    const backups = this._getBackups();
    backups.slice(2).forEach(b => { try { fs.unlinkSync(b.path); } catch (_) {} });
  }

  _getBackups() {
    if (!fs.existsSync(this.updatesDir)) return [];
    return fs.readdirSync(this.updatesDir)
      .filter(f => f.startsWith('backup-v') && f.endsWith('.zip'))
      .map(f => ({
        filename: f,
        version: f.replace('backup-v', '').replace('.zip', ''),
        path: path.join(this.updatesDir, f),
        created: fs.statSync(path.join(this.updatesDir, f)).mtime
      }))
      .sort((a, b) => b.created - a.created);
  }

  // ─── NETWORK ────────────────────────────────────────────────────────

  _fetchJSON(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'HammamPOS' }, timeout: 10000 }, (res) => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  _downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let totalSize = this.latestRelease ? this.latestRelease.size : 0;
      let downloaded = 0;

      const follow = (reqUrl) => {
        const mod = reqUrl.startsWith('https') ? https : require('http');
        mod.get(reqUrl, { headers: { 'User-Agent': 'HammamPOS' }, timeout: 120000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return follow(res.headers.location);
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
        }).on('error', err => {
          file.close();
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      };

      follow(url);
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
