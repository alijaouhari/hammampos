/**
 * HammamPOS - RemoteAdmin
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 *
 * Lets the manager operate this PC's admin panel from the dashboard.
 *
 * Transport: private Realtime broadcast topic 'admin-rpc:<location_id>' (only the
 * manager and this PC's device login may use it — see migration 07).
 *   request  (event 'req'): { id, session, channel, args }
 *   response (event 'res'): { id, ok, result | error, part, parts }
 *
 * Security, in addition to the private topic:
 *  1. A request must name a remote_sessions row of this location that the server
 *     says is open and not expired (only a manager can create such rows).
 *  2. The session is unlocked with THIS hammam's admin password, checked here.
 *     5 wrong passwords lock remote opening for 10 minutes.
 *  3. Only channels in the allow-list run; a few settings keys are never writable.
 */

// Admin-panel actions allowed remotely. Everything else is refused.
const ALLOW_PREFIXES = ['storage:', 'money:', 'float:', 'dayStatus:', 'expenseTemplates:', 'wood:'];
const ALLOW_EXACT = new Set([
  'settings:getAll', 'settings:updateSettings', 'settings:verifyAdminPassword',
  'excel:getStatus', 'excel:rebuild', 'backup:getStatus', 'backup:rebuild',
  'cloud:getStatus', 'cloud:fullSync', 'cloud:testConnection', 'diagnostics:get',
  'email:testConnection', 'update:getStatus', 'update:check', 'update:getProgress', 'update:getReleases',
  'printer:listPrinters', 'recovery:getStatus'
]);
// Never remotely, even if the prefix is allowed: wipes, fake data, selling / seller-only actions.
const DENY = new Set([
  'storage:clearAllData', 'storage:generateTestData', 'storage:createTicket', 'money:refundTicket'
]);
// Settings that would cut the PC off the cloud or change who can log in.
const PROTECTED_SETTINGS = /^(cloud_|device_|location_id$|admin_password|recovery_|remote_notice$)/;

const MAX_PART = 180000; // characters per broadcast message
const MAX_BAD_PASSWORDS = 5;
const LOCK_MS = 10 * 60 * 1000;

function isAllowed(channel) {
  if (typeof channel !== 'string' || DENY.has(channel)) return false;
  return ALLOW_EXACT.has(channel) || ALLOW_PREFIXES.some(p => channel.startsWith(p));
}

class RemoteAdmin {
  /**
   * @param {CloudSync} cloud  provides .supabase and .locationId
   * @param {{ invoke:(channel:string, args:any[])=>Promise<any>, verifyPassword:(pw:string)=>boolean|Promise<boolean>,
   *           onSessionsChanged?:(count:number)=>void }} hooks
   */
  constructor(cloud, hooks) {
    this.cloud = cloud;
    this.hooks = hooks;
    this.channel = null;
    this.live = false;
    this.sessions = new Map(); // id -> { checkedAt, touchedAt }
    this.badPasswords = [];
    this.lockedUntil = 0;
  }

  get sb() { return this.cloud.supabase; }

  async start() {
    if (!this.sb || !this.cloud.locationId || typeof this.sb.channel !== 'function') return;
    this.stop();
    try { if (this.sb.realtime && this.sb.realtime.setAuth) await this.sb.realtime.setAuth(); } catch (_) {}
    this.channel = this.sb.channel('admin-rpc:' + this.cloud.locationId, { config: { private: true, broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'req' }, (msg) => { this.onRequest(msg && msg.payload).catch(() => {}); })
      .subscribe((status) => { this.live = status === 'SUBSCRIBED'; });
  }

  stop() {
    if (this.channel) { try { this.sb.removeChannel(this.channel); } catch (_) {} }
    this.channel = null;
    this.live = false;
  }

  activeSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.touchedAt > 30 * 60 * 1000) this.sessions.delete(id);
    return this.sessions.size;
  }

  _changed() { if (this.hooks.onSessionsChanged) this.hooks.onSessionsChanged(this.activeSessions()); }

  async _sessionIsValid(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return false;
    const { data, error } = await this.sb.rpc('remote_session_valid', { sid: id });
    return !error && data === true;
  }

  async _reply(id, payload) {
    if (!this.channel) return;
    const text = JSON.stringify(payload);
    if (text.length <= MAX_PART) {
      await this.channel.send({ type: 'broadcast', event: 'res', payload: { id, ...payload } });
      return;
    }
    const parts = Math.ceil(text.length / MAX_PART);
    for (let i = 0; i < parts; i++) {
      await this.channel.send({ type: 'broadcast', event: 'res', payload: { id, part: i, parts, chunk: text.slice(i * MAX_PART, (i + 1) * MAX_PART) } });
    }
  }

  async onRequest(req) {
    if (!req || typeof req.id !== 'string') return;
    const { id, session, channel } = req;
    const args = Array.isArray(req.args) ? req.args : [];
    try {
      if (channel === 'remote:open') return await this._open(id, session, args[0]);
      if (channel === 'remote:close') {
        this.sessions.delete(session);
        await this.sb.from('remote_sessions').update({ ended_at: new Date().toISOString() }).eq('id', session);
        this._changed();
        return await this._reply(id, { ok: true, result: { closed: true } });
      }
      const s = this.sessions.get(session);
      if (!s) return await this._reply(id, { ok: false, error: 'session', message: 'الجلسة غير مفتوحة: أدخل كلمة مرور الإدارة' });
      const now = Date.now();
      // Re-check with the server every 2 minutes (manager may have ended it; server clock).
      if (now - s.checkedAt > 2 * 60 * 1000) {
        if (!(await this._sessionIsValid(session))) {
          this.sessions.delete(session); this._changed();
          return await this._reply(id, { ok: false, error: 'session', message: 'انتهت الجلسة: افتحها من جديد' });
        }
        s.checkedAt = now;
      }
      if (now - s.touchedAt > 60 * 1000) { s.touchedAt = now; this.sb.rpc('remote_session_touch', { sid: session }).then(() => {}, () => {}); }
      if (!isAllowed(channel)) return await this._reply(id, { ok: false, error: 'denied', message: 'هذا الإجراء متاح من الجهاز نفسه فقط' });
      let callArgs = args;
      if (channel === 'settings:updateSettings' && callArgs[0] && typeof callArgs[0] === 'object') {
        const clean = {};
        for (const [k, v] of Object.entries(callArgs[0])) if (!PROTECTED_SETTINGS.test(k)) clean[k] = v;
        callArgs = [clean, ...callArgs.slice(1)];
      }
      const result = await this.hooks.invoke(channel, callArgs);
      let out = result;
      if (channel === 'settings:getAll' && out && typeof out === 'object') {
        out = { ...out };
        for (const k of Object.keys(out)) if (/password|recovery|device_|cloud_key/.test(k)) out[k] = out[k] ? '••••••' : out[k];
      }
      return await this._reply(id, { ok: true, result: out === undefined ? null : out });
    } catch (error) {
      return await this._reply(id, { ok: false, error: 'failed', message: String((error && error.message) || error) });
    }
  }

  async _open(id, session, password) {
    const now = Date.now();
    if (now < this.lockedUntil) {
      return this._reply(id, { ok: false, error: 'locked', message: 'محاولات كثيرة خاطئة: انتظر 10 دقائق' });
    }
    if (!(await this._sessionIsValid(session))) {
      return this._reply(id, { ok: false, error: 'session', message: 'جلسة غير صالحة أو منتهية' });
    }
    const ok = await this.hooks.verifyPassword(String(password == null ? '' : password));
    if (!ok) {
      this.badPasswords = this.badPasswords.filter(t => now - t < LOCK_MS);
      this.badPasswords.push(now);
      if (this.badPasswords.length >= MAX_BAD_PASSWORDS) { this.lockedUntil = now + LOCK_MS; this.badPasswords = []; }
      return this._reply(id, { ok: false, error: 'password', message: 'كلمة مرور الإدارة غير صحيحة' });
    }
    this.badPasswords = [];
    this.sessions.set(session, { checkedAt: now, touchedAt: now });
    await this.sb.from('remote_sessions').update({ password_ok: true }).eq('id', session);
    this._changed();
    return this._reply(id, { ok: true, result: { opened: true, hammam: this.cloud.storage ? this.cloud.storage.getSetting('hammam_name') : null } });
  }
}

RemoteAdmin.isAllowed = isAllowed;
RemoteAdmin.PROTECTED_SETTINGS = PROTECTED_SETTINGS;
RemoteAdmin.MAX_PART = MAX_PART;
module.exports = RemoteAdmin;
