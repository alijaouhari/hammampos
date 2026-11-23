/**
 * PC health for the dashboard and the phone: printer, free disk space, cloud backup
 * age, app restarts. Problems show on the dashboard; each kind also sends one phone
 * alert ('health'), at most every 6 hours while it lasts.
 */
'use strict';
const fs = require('fs');

const LIMITS = {
  diskFreeGb: 2,          // less than this on the database's drive
  backupDays: 2,          // no cloud copy for more than this
  printerMinutes: 30,     // a print failed recently and nothing printed since
  restartsPerDay: 6       // the app started this many times today
};
const RENOTIFY_MS = 6 * 3600 * 1000;

class HealthMonitor {
  constructor({ storage, backupStatus = () => null, notify = () => {}, now = () => new Date(), diskFree = null, dbPath = null }) {
    this.storage = storage;
    this.backupStatus = backupStatus;
    this.notify = notify;
    this.now = now;
    this.dbPath = dbPath || storage.dbPath;
    this.diskFreeFn = diskFree || ((p) => {
      try { const s = fs.statfsSync(require('path').parse(p).root); return s.bavail * s.bsize; } catch (_) { return null; }
    });
    this.printer = { lastOkAt: null, lastError: null, lastErrorAt: null, failsToday: 0, day: null };
    this.startedAt = now().toISOString();
  }

  /** Remember this start (for the "restarts today" check). */
  noteStart() {
    const day = this.now().toISOString().slice(0, 10);
    const prev = (this.storage.getSetting('app_starts') || '').split(',').filter(x => x.startsWith(day));
    prev.push(this.now().toISOString().slice(0, 19));
    this.storage.setSetting('app_starts', prev.slice(-50).join(','));
  }
  startsToday() {
    const day = this.now().toISOString().slice(0, 10);
    return (this.storage.getSetting('app_starts') || '').split(',').filter(x => x.startsWith(day)).length;
  }

  printOk() { this.printer.lastOkAt = this.now().toISOString(); }
  printFailed(error) {
    const day = this.now().toISOString().slice(0, 10);
    if (this.printer.day !== day) { this.printer.day = day; this.printer.failsToday = 0; }
    this.printer.failsToday++;
    this.printer.lastError = String(error && error.message || error).slice(0, 200);
    this.printer.lastErrorAt = this.now().toISOString();
    this.check(); // a printer problem is worth an alert right away
  }

  /** Current problems: [{ kind, text }] */
  problems() {
    const out = [];
    const now = this.now().getTime();
    const free = this.diskFreeFn(this.dbPath);
    if (free != null && free < LIMITS.diskFreeGb * 1024 ** 3) out.push({ kind: 'disk', text: 'المساحة الفارغة على القرص ' + (free / 1024 ** 3).toFixed(1) + ' GB فقط' });
    const b = this.backupStatus();
    if (b) {
      const last = b.at ? Date.parse(b.at) : null;
      const runningFor = now - Date.parse(this.startedAt);
      if (last && now - last > LIMITS.backupDays * 86400000) out.push({ kind: 'backup', text: 'آخر نسخة احتياطية في السحابة منذ ' + Math.floor((now - last) / 86400000) + ' أيام' + (b.error ? ': ' + b.error : '') });
      else if (!last && b.error && runningFor > 3600000) out.push({ kind: 'backup', text: 'النسخة الاحتياطية في السحابة لا تعمل: ' + b.error });
    }
    const p = this.printer;
    if (p.lastErrorAt && now - Date.parse(p.lastErrorAt) < LIMITS.printerMinutes * 60000 && (!p.lastOkAt || p.lastOkAt < p.lastErrorAt)) {
      out.push({ kind: 'printer', text: 'الطابعة لا تطبع: ' + p.lastError });
    }
    const starts = this.startsToday();
    if (starts >= LIMITS.restartsPerDay) out.push({ kind: 'restarts', text: 'البرنامج أُعيد تشغيله ' + starts + ' مرات اليوم' });
    return out;
  }

  /** Check and send a phone alert for new problems (each kind at most every 6 hours). */
  check() {
    const list = this.problems();
    for (const pr of list) {
      const key = 'health_notified_' + pr.kind;
      const last = Number(this.storage.getSetting(key)) || 0;
      if (this.now().getTime() - last < RENOTIFY_MS) continue;
      this.storage.setSetting(key, String(this.now().getTime()));
      try { this.notify(pr); } catch (_) {}
    }
    return list;
  }

  /** For the dashboard (device info). */
  info() {
    const free = this.diskFreeFn(this.dbPath);
    return {
      diskFreeGb: free == null ? null : Math.round(free / 1024 ** 3 * 10) / 10,
      printer: { ...this.printer },
      backup: this.backupStatus(),
      startsToday: this.startsToday(),
      startedAt: this.startedAt,
      problems: this.problems()
    };
  }
}

HealthMonitor.LIMITS = LIMITS;
module.exports = HealthMonitor;
