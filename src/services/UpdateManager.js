/**
 * HammamPOS - UpdateManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Handles version checking, downloading, applying, and reverting updates.
 * 
 * Flow:
 *   1. checkForUpdate() — compares local version to latest GitHub Release
 *   2. downloadUpdate() — downloads ZIP to temp, backs up current install
 *   3. applyUpdate()    — extracts ZIP over install directory
 *   4. revertUpdate()   — restores backup ZIP over install directory
 * 
 * Install dir: C:\HammamPOS (contains exe, asar, DLLs)
 * Data dir:    %APPDATA%\HammamPOS (contains DB — never touched by updates)
 * Backup dir:  %APPDATA%\HammamPOS\updates\ (previous version ZIPs)
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

  /**
   * Check GitHub Releases for a newer version.
   * Returns null if up-to-date or if check fails (no internet).
   */
  async checkForUpdate() {
    try {
      const release = await this._fetchLatestRelease();
      if (!release) return null;

      const remoteVersion = release.tag_name.replace(/^v/, '');
      if (!this._isNewer(remoteVersion, this.currentVersion)) {
        return null;
      }

      // Find the ZIP asset
      const zipAsset = release.assets.find(a => a.name.endsWith('.zip'));
      if (!zipAsset) return null;

      this.latestRelease = {
        version: remoteVersion,
        tag: release.tag_name,
        notes: release.body || '',
        downloadUrl: zipAsset.browser_download_url,
        size: zipAsset.size,
        publishedAt: release.published_at
      };

      return this.latestRelease;
    } catch (error) {
      // Silently fail — no internet or API error
      console.warn('☁️ Update check failed:', error.message);
      return null;
    }
  }

  /**
   * Download the update ZIP and back up the current installation.
   */
  async downloadUpdate() {
    if (!this.latestRelease) throw new Error('No update available');
    if (this.isDownloading) throw new Error('Download already in progress');

    this.isDownloading = true;
    this.downloadProgress = 0;

    const zipPath = path.join(this.updatesDir, `HammamPOS-${this.latestRelease.version}.zip`);

    try {
      // Step 1: Download
      await this._downloadFile(this.latestRelease.downloadUrl, zipPath);

      // Step 2: Backup current installation
      await this._backupCurrentInstall();

      this.isDownloading = false;
      return { success: true, zipPath };
    } catch (error) {
      this.isDownloading = false;
      // Clean up partial download
      try { fs.unlinkSync(zipPath); } catch (_) {}
      throw error;
    }
  }

  /**
   * Apply the downloaded update by extracting over the install directory.
   * Returns instructions for the user to restart.
   */
  async applyUpdate() {
    if (!this.latestRelease) throw new Error('No update available');

    const zipPath = path.join(this.updatesDir, `HammamPOS-${this.latestRelease.version}.zip`);
    if (!fs.existsSync(zipPath)) {
      throw new Error('Update file not found — download first');
    }

    // Extract ZIP over install directory using PowerShell
    // The -Force flag overwrites existing files
    const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${this.installDir}' -Force"`;
    execSync(cmd, { timeout: 120000 });

    // Clean up the downloaded ZIP (backup is separate)
    try { fs.unlinkSync(zipPath); } catch (_) {}

    return { success: true, version: this.latestRelease.version };
  }

  /**
   * Revert to the previous version using the backup.
   */
  async revertUpdate() {
    const backups = this._getAvailableBackups();
    if (backups.length === 0) {
      throw new Error('لا توجد نسخة سابقة للرجوع إليها');
    }

    // Use the most recent backup
    const latestBackup = backups[0];

    // Extract backup over install directory
    const cmd = `powershell -Command "Expand-Archive -Path '${latestBackup.path}' -DestinationPath '${this.installDir}' -Force"`;
    execSync(cmd, { timeout: 120000 });

    return { success: true, revertedTo: latestBackup.version };
  }

  /**
   * Get current status for the UI.
   */
  getStatus() {
    return {
      currentVersion: this.currentVersion,
      latestRelease: this.latestRelease,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      availableBackups: this._getAvailableBackups()
    };
  }

  // ─── PRIVATE METHODS ────────────────────────────────────────────────

  /**
   * Fetch the latest release from GitHub API.
   */
  _fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        headers: { 'User-Agent': 'HammamPOS-Updater' },
        timeout: 10000
      };

      https.get(RELEASES_API, options, (res) => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
    });
  }

  /**
   * Download a file with redirect following and progress tracking.
   */
  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let totalSize = this.latestRelease ? this.latestRelease.size : 0;
      let downloaded = 0;

      const request = (requestUrl) => {
        const mod = requestUrl.startsWith('https') ? https : require('http');
        mod.get(requestUrl, { headers: { 'User-Agent': 'HammamPOS-Updater' }, timeout: 60000 }, (res) => {
          // Follow redirects (GitHub redirects to CDN)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            request(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            fs.unlinkSync(destPath);
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          if (res.headers['content-length']) {
            totalSize = parseInt(res.headers['content-length'], 10);
          }

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            this.downloadProgress = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
          });

          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
        }).on('error', (err) => { file.close(); fs.unlinkSync(destPath); reject(err); });
      };

      request(url);
    });
  }

  /**
   * Create a backup ZIP of the current installation.
   * Only backs up files that an update would overwrite (exe, DLLs, asar, resources).
   * Keeps only the 2 most recent backups to save disk space.
   */
  async _backupCurrentInstall() {
    const backupName = `backup-v${this.currentVersion}.zip`;
    const backupPath = path.join(this.updatesDir, backupName);

    // Skip if this version is already backed up
    if (fs.existsSync(backupPath)) return;

    // Create backup using PowerShell
    const cmd = `powershell -Command "Compress-Archive -Path '${this.installDir}\\*' -DestinationPath '${backupPath}' -Force"`;
    execSync(cmd, { timeout: 180000 });

    // Prune old backups — keep only 2 most recent
    const backups = this._getAvailableBackups();
    if (backups.length > 2) {
      backups.slice(2).forEach(b => {
        try { fs.unlinkSync(b.path); } catch (_) {}
      });
    }
  }

  /**
   * List available backup ZIPs sorted newest first.
   */
  _getAvailableBackups() {
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

  /**
   * Compare two semver strings. Returns true if remote > local.
   */
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
