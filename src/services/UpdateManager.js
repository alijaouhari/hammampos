/**
 * HammamPOS - UpdateManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Self-update system for HammamPOS desktop application.
 * 
 * Architecture:
 *   A running Electron app cannot overwrite its own exe/asar (Windows locks them).
 *   Solution: write a batch script that waits for the app to exit, performs the
 *   file extraction, then relaunches the app. The app spawns the script detached
 *   and immediately quits.
 * 
 * Update flow:
 *   1. checkForUpdate()  → compare local version to GitHub Releases latest tag
 *   2. downloadUpdate()  → download ZIP, backup current install
 *   3. applyAndRestart() → write batch script, spawn it detached, quit app
 *   4. [batch script]    → wait for process exit, extract ZIP, relaunch exe
 * 
 * Revert flow:
 *   1. revertAndRestart() → same as apply but uses the backup ZIP instead
 * 
 * Paths:
 *   Install:  C:\HammamPOS\          (exe, asar, DLLs — overwritten by updates)
 *   Data:     %APPDATA%\HammamPOS\   (database — never touched)
 *   Updates:  %APPDATA%\HammamPOS\updates\ (downloaded ZIPs, backups, scripts)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
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
      console.warn('☁️ Update check failed:', error.message);
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
   * Spawn the update script and quit the app.
   * Caller must call app.exit() after this returns.
   */
  applyAndRestart() {
    if (!this.latestRelease) throw new Error('No update available');

    const zipPath = path.join(this.updatesDir, `update-v${this.latestRelease.version}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error('Update ZIP not found');

    this._spawnUpdateScript(zipPath);
    return { success: true };
  }

  /**
   * Revert to previous version. Spawn script and quit.
   * Caller must call app.exit() after this returns.
   */
  revertAndRestart() {
    const backups = this._getBackups();
    if (backups.length === 0) throw new Error('لا توجد نسخة سابقة للرجوع إليها');

    this._spawnUpdateScript(backups[0].path);
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

  // ─── CORE MECHANISM ─────────────────────────────────────────────────

  /**
   * Write and spawn a detached batch script that:
   *   1. Waits for HammamPOS.exe to exit
   *   2. Extracts the given ZIP over the install directory
   *   3. Relaunches HammamPOS.exe
   *   4. Deletes itself
   */
  _spawnUpdateScript(zipPath) {
    const scriptPath = path.join(this.updatesDir, 'apply.bat');
    const exePath = path.join(this.installDir, 'HammamPOS.exe');

    const bat = [
      '@echo off',
      'title HammamPOS - جاري التحديث...',
      'echo Waiting for app to close...',
      'timeout /t 3 /nobreak >nul',
      ':wait',
      'tasklist /FI "IMAGENAME eq HammamPOS.exe" 2>NUL | find /I "HammamPOS.exe" >NUL',
      'if not errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait )',
      'echo Extracting update...',
      `powershell -Command "Expand-Archive -Path '%zipPath%' -DestinationPath '%installDir%' -Force"`,
      'echo Starting HammamPOS...',
      `start "" "%exePath%"`,
      'del "%~f0"',
    ].join('\r\n')
      .replace(/%zipPath%/g, zipPath)
      .replace(/%installDir%/g, this.installDir)
      .replace(/%exePath%/g, exePath);

    fs.writeFileSync(scriptPath, bat, 'utf8');

    // Spawn detached — the script outlives this process
    spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
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
        }).on('error', err => { file.close(); try { fs.unlinkSync(dest); } catch (_) {} reject(err); });
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
