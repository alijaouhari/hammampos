/**
 * Daily copy of the whole database (everything: tickets, money system, wood, settings)
 * to the cloud, in a private folder only this PC can write and only the manager can read.
 *
 * - Once a day, a few minutes after the app starts (and again later if it failed).
 * - File: backups/<location id>/<YYYY-MM-DD>.db.gz (about 1/4 of the database size).
 * - Kept: the last 30 days, plus the 1st of every month.
 * - Status (last copy, size, error) goes to the dashboard with the device info.
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const BUCKET = 'backups';
const KEEP_DAYS = 30;
const RETRY_MS = 30 * 60 * 1000;       // after a failure
const FIRST_DELAY_MS = 3 * 60 * 1000;  // not right at start-up

class CloudBackup {
  /**
   * @param {object} o
   * @param {object} o.storage          StorageManager (dbPath, getSetting, setSetting)
   * @param {function} o.client         () => supabase client (signed in as the device) or null
   * @param {function} o.locationId     () => location id or null
   * @param {function} [o.now]
   */
  constructor({ storage, client, locationId, now = () => new Date(), log = () => {} }) {
    this.storage = storage;
    this.client = client;
    this.locationId = locationId;
    this.now = now;
    this.log = log;
    this.startedAt = now().getTime();
    this.lastTryAt = 0;
    this.running = false;
  }

  _day(d = this.now()) { return d.toISOString().slice(0, 10); }

  status() {
    const g = (k) => this.storage.getSetting(k);
    return {
      day: g('cloud_backup_day') || null,
      at: g('cloud_backup_at') || null,
      size: Number(g('cloud_backup_size')) || null,
      error: g('cloud_backup_error') || null,
      errorAt: g('cloud_backup_error_at') || null
    };
  }

  /** True when today's copy is not in the cloud yet and it is time to try. */
  isDue() {
    const t = this.now().getTime();
    if (t - this.startedAt < FIRST_DELAY_MS) return false;
    if (this.storage.getSetting('cloud_backup_day') === this._day()) return false;
    return t - this.lastTryAt >= RETRY_MS;
  }

  /** Called by every heartbeat; does nothing unless due. */
  async maybeRun() {
    if (this.running || !this.isDue()) return null;
    return this.run();
  }

  /** Upload now (also used by the dashboard's "backup now" command). */
  async run() {
    if (this.running) return { ok: false, error: 'busy' };
    this.running = true;
    this.lastTryAt = this.now().getTime();
    try {
      const sb = this.client(), loc = this.locationId();
      if (!sb || !loc) throw new Error('cloud not linked');
      const raw = fs.readFileSync(this.storage.dbPath);
      const gz = zlib.gzipSync(raw, { level: 9 });
      const day = this._day();
      const name = `${loc}/${day}.db.gz`;
      const { error } = await sb.storage.from(BUCKET).upload(name, gz, { upsert: true, contentType: 'application/gzip' });
      if (error) throw new Error(error.message || String(error));
      const at = this.now().toISOString();
      this.storage.setSetting('cloud_backup_day', day);
      this.storage.setSetting('cloud_backup_at', at);
      this.storage.setSetting('cloud_backup_size', String(gz.length));
      this.storage.setSetting('cloud_backup_error', '');
      this.storage.setSetting('cloud_backup_error_at', '');
      if (this.storage.save) this.storage.save();
      const removed = await this._prune(sb, loc).catch(() => []);
      this.log(`cloud backup ${name} (${Math.round(gz.length / 1024)} KB)` + (removed.length ? `, removed ${removed.length} old` : ''));
      return { ok: true, name, size: gz.length, dbSize: raw.length, removed };
    } catch (error) {
      const msg = String(error && error.message || error).slice(0, 300);
      this.storage.setSetting('cloud_backup_error', msg);
      if (!this.storage.getSetting('cloud_backup_error_at')) this.storage.setSetting('cloud_backup_error_at', this.now().toISOString());
      if (this.storage.save) this.storage.save();
      this.log('cloud backup failed: ' + msg);
      return { ok: false, error: msg };
    } finally {
      this.running = false;
    }
  }

  /** Names to delete: older than KEEP_DAYS, except the 1st of a month. */
  static toPrune(names, today, keepDays = KEEP_DAYS) {
    const limit = new Date(Date.parse(today) - keepDays * 86400000).toISOString().slice(0, 10);
    return names.filter(n => {
      const m = /^(\d{4}-\d{2}-(\d{2}))\.db\.gz$/.exec(n);
      return m && m[1] < limit && m[2] !== '01';
    });
  }

  async _prune(sb, loc) {
    const { data, error } = await sb.storage.from(BUCKET).list(loc, { limit: 1000 });
    if (error || !data) return [];
    const old = CloudBackup.toPrune(data.map(f => f.name), this._day());
    if (!old.length) return [];
    await sb.storage.from(BUCKET).remove(old.map(n => `${loc}/${n}`));
    return old;
  }
}

CloudBackup.BUCKET = BUCKET;
module.exports = CloudBackup;
