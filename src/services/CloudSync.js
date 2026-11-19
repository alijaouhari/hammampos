/**
 * HammamPOS - CloudSync
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 *
 * Syncs tickets, expenses, and collections to Supabase.
 *  - Creates/updates are sent right away; deletes and refunds are sent as deletes.
 *  - Anything that fails (offline) goes to a local queue and is retried every 30 s.
 *  - reconcile() compares the whole local data with the cloud and repairs differences
 *    (used at start-up, by the "full sync" button, and as a safety net).
 *  - A heartbeat every 15 s tells the dashboard the device is alive (version, queue,
 *    last error) and answers "test connection" pings sent from the dashboard.
 *
 * Config (stored in settings): cloud_url, cloud_key, location_id, location_name
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const TABLES = ['tickets', 'expenses', 'collections'];
const CODE_PREFIX = 'HPOS1.';

function describeError(error) {
  const msg = String((error && (error.message || error.details)) || error || '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(msg)) {
    return 'تعذّر الوصول إلى الخادم: تحقق من الإنترنت ومن رابط المشروع';
  }
  if (/invalid api key|jwt|apikey/i.test(msg) || (error && (error.status === 401 || error.status === 403))) {
    return 'مفتاح الاتصال غير صحيح';
  }
  if (/relation .* does not exist|schema cache|PGRST205|42P01/i.test(msg)) {
    return 'الجداول غير موجودة في مشروع Supabase هذا';
  }
  return msg || 'خطأ غير معروف';
}

class CloudSync {
  /**
   * @param {StorageManager} storage
   * @param {{appVersion?:string, getDeviceInfo?:()=>object, getLocalRows?:()=>{tickets:object[],expenses:object[],collections:object[]}}} [options]
   */
  constructor(storage, options = {}) {
    this.storage = storage;
    this.options = options;
    this.supabase = null;
    this.locationId = null;
    this.enabled = false;
    this.syncing = false;
    this.retryInterval = null;
    this.heartbeatInterval = null;
    this.lastError = null;
    this.lastSyncAt = null;
    this.lastHeartbeatAt = null;
    this.online = false;
    this.reconciling = false;
    this.lastReconcile = null;
  }

  // ─── Connection code (what the dashboard gives to a new device) ─────

  static encodeConnection({ url, key, locationId, name }) {
    const json = JSON.stringify({ u: url, k: key, l: locationId || null, n: name || null });
    return CODE_PREFIX + Buffer.from(json, 'utf8').toString('base64');
  }

  static decodeConnection(code) {
    const text = String(code || '').trim();
    if (!text.startsWith(CODE_PREFIX)) throw new Error('رمز الربط غير صالح');
    let obj;
    try {
      obj = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), 'base64').toString('utf8'));
    } catch (_) {
      throw new Error('رمز الربط غير صالح');
    }
    if (!obj || !obj.u || !obj.k) throw new Error('رمز الربط ناقص');
    return { url: obj.u, key: obj.k, locationId: obj.l || null, name: obj.n || null };
  }

  // ─── Connection test (does not need the sync to be running) ─────────

  /**
   * Checks, step by step, that this device can reach the project, that the key works,
   * that the tables exist, and (when a location id is known) that it can write.
   */
  static async testConnection(url, key, locationId = null) {
    const steps = [];
    const started = Date.now();
    const add = (name, ok, detail) => steps.push({ name, ok, detail });
    if (!url || !key) {
      add('الإعدادات', false, 'رابط المشروع أو المفتاح فارغ');
      return { ok: false, steps, latencyMs: null };
    }
    if (!/^https:\/\/.+/i.test(url)) {
      add('الإعدادات', false, 'رابط المشروع يجب أن يبدأ بـ https://');
      return { ok: false, steps, latencyMs: null };
    }
    let client;
    try {
      client = createClient(url, key, { realtime: { transport: WebSocket } });
    } catch (e) {
      add('الإعدادات', false, describeError(e));
      return { ok: false, steps, latencyMs: null };
    }
    let latencyMs = null;
    try {
      const t0 = Date.now();
      const { error } = await client.from('locations').select('id').limit(1);
      latencyMs = Date.now() - t0;
      if (error) {
        add('الوصول إلى الخادم', false, describeError(error));
        return { ok: false, steps, latencyMs };
      }
      add('الوصول إلى الخادم والمفتاح', true, `${latencyMs} ms`);
    } catch (e) {
      add('الوصول إلى الخادم', false, describeError(e));
      return { ok: false, steps, latencyMs };
    }
    for (const t of TABLES) {
      const { error } = await client.from(t).select('local_id').limit(1);
      add(`جدول ${t}`, !error, error ? describeError(error) : 'موجود');
    }
    if (locationId) {
      const { data, error } = await client.from('locations').select('id,name').eq('id', locationId).maybeSingle();
      if (error) add('هذا الجهاز في اللوحة', false, describeError(error));
      else if (!data) add('هذا الجهاز في اللوحة', false, 'معرف الفرع غير موجود في اللوحة (سيُسجَّل من جديد عند إعادة الاتصال)');
      else {
        add('هذا الجهاز في اللوحة', true, data.name);
        const upd = await client.from('locations').update({ last_seen_at: new Date().toISOString() }).eq('id', locationId);
        add('الكتابة في السحابة', !upd.error, upd.error ? describeError(upd.error) : 'تمت');
      }
    }
    return { ok: steps.every(s => s.ok), steps, latencyMs, totalMs: Date.now() - started };
  }

  // ─── Start / stop ───────────────────────────────────────────────────

  /**
   * Initialize cloud sync. Returns silently if not configured. If the internet is down
   * at start-up the sync still starts (changes are queued) and registers later.
   */
  async initialize() {
    const url = this.storage.getSetting('cloud_url');
    const key = this.storage.getSetting('cloud_key');

    if (!url || !key) {
      console.log('☁️ Cloud sync not configured (no URL/key)');
      return { success: false, reason: 'not_configured' };
    }

    try {
      this.supabase = createClient(url, key, {
        realtime: { transport: WebSocket }
      });
    } catch (error) {
      this.lastError = describeError(error);
      console.error('☁️ Cloud sync init failed:', error.message);
      return { success: false, reason: error.message };
    }

    this._ensureQueueTable();
    this.locationId = this.storage.getSetting('location_id') || null;
    // With a known location we can queue right away, even offline.
    this.enabled = true;

    try {
      await this.ensureLocation();
      this.online = true;
      this.lastError = null;
    } catch (error) {
      this.online = false;
      this.lastError = describeError(error);
      console.warn('☁️ Cloud not reachable yet, will retry:', this.lastError);
    }

    this._startTimers();
    if (this.online) {
      await this.processQueue();
      this.heartbeat().catch(() => {});
      // Repair any difference between this device and the cloud (once, a bit after start).
      setTimeout(() => this.reconcile().catch(() => {}), 20000).unref();
    }
    console.log(`☁️ Cloud sync started: ${this.storage.getSetting('location_name')} (${this.locationId || 'not registered yet'})`);
    return { success: true, locationId: this.locationId, online: this.online };
  }

  _ensureQueueTable() {
    this.storage.db.run(`CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(table_name, local_id)
    )`);
    // op: 'upsert' (default) or 'delete'
    try { this.storage.db.run("ALTER TABLE sync_queue ADD COLUMN op TEXT NOT NULL DEFAULT 'upsert'"); } catch (_) {}
    this.storage.save();
  }

  _startTimers() {
    this._clearTimers();
    // Queue + re-registration every 30 s
    this.retryInterval = setInterval(() => this._tick(), 30000);
    // Heartbeat / ping answer every 15 s
    this.heartbeatInterval = setInterval(() => this.heartbeat().catch(() => {}), 15000);
    if (this.retryInterval.unref) this.retryInterval.unref();
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  _clearTimers() {
    if (this.retryInterval) clearInterval(this.retryInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.retryInterval = null;
    this.heartbeatInterval = null;
  }

  async _tick() {
    if (!this.enabled) return;
    if (!this.online || !this.locationId) {
      try {
        await this.ensureLocation();
        this.online = true;
        this.lastError = null;
        this.scheduleReconcile(5000); // we were offline: make sure nothing was missed
      } catch (error) {
        this.online = false;
        this.lastError = describeError(error);
        return;
      }
    }
    await this.processQueue();
  }

  /**
   * Register this location in Supabase if not already done. Throws when the cloud
   * cannot be reached. A known location is only re-registered if the cloud answers
   * and the row is really gone.
   */
  async ensureLocation() {
    const locationId = this.storage.getSetting('location_id');
    const locationName = this.storage.getSetting('location_name') || this.storage.getSetting('hammam_name') || 'Unknown';

    if (locationId) {
      const { data, error } = await this.supabase
        .from('locations')
        .select('id')
        .eq('id', locationId)
        .maybeSingle();
      if (error) throw error;            // offline / bad key: keep the id, try later
      if (data) {
        this.locationId = locationId;
        return;
      }
      console.warn('☁️ Location row missing in the cloud, registering again');
    }

    const { data, error } = await this.supabase
      .from('locations')
      .insert({ name: locationName })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to register location: ${error.message}`);

    this.locationId = data.id;
    this.storage.setSetting('location_id', data.id);
    console.log(`☁️ Location registered: ${locationName} → ${data.id}`);
    // A brand-new location has nothing in the cloud yet: send everything.
    setTimeout(() => this.reconcile().catch(() => {}), 2000).unref();
  }

  // ─── SYNC METHODS ───────────────────────────────────────────────────

  _ticketRow(ticket) {
    return {
      location_id: this.locationId,
      local_id: ticket.id,
      serial_number: ticket.serial_number,
      year: ticket.year,
      category_name: ticket.category_name,
      price: ticket.price,
      date: ticket.date,
      time: ticket.time
    };
  }

  _expenseRow(expense) {
    return {
      location_id: this.locationId,
      local_id: expense.id,
      description: expense.description,
      amount: expense.amount,
      date: expense.date,
      time: expense.time
    };
  }

  _collectionRow(collection) {
    return {
      location_id: this.locationId,
      local_id: collection.id,
      amount: collection.amount,
      notes: collection.notes || null,
      date: collection.date,
      time: collection.time
    };
  }

  async _upsert(table, localId, row) {
    if (!this.enabled) return;
    if (!this.locationId) { this.queueItem(table, localId, row, 'upsert'); return; }
    try {
      const { error } = await this.supabase.from(table).upsert({ ...row, location_id: this.locationId }, { onConflict: 'location_id,local_id' });
      if (error) throw error;
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.lastError = describeError(error);
      this.queueItem(table, localId, row, 'upsert');
    }
  }

  async _delete(table, localId) {
    if (!this.enabled) return;
    if (!this.locationId) { this.queueItem(table, localId, {}, 'delete'); return; }
    try {
      const { error } = await this.supabase.from(table).delete().eq('location_id', this.locationId).eq('local_id', localId);
      if (error) throw error;
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.lastError = describeError(error);
      this.queueItem(table, localId, {}, 'delete');
    }
  }

  /** Sync a ticket to the cloud. A refunded ticket is removed from the cloud (it is not income). */
  async syncTicket(ticket) {
    if (ticket && ticket.refunded_at) return this._delete('tickets', ticket.id);
    return this._upsert('tickets', ticket.id, this._ticketRow(ticket));
  }
  async syncExpense(expense) { return this._upsert('expenses', expense.id, this._expenseRow(expense)); }
  async syncCollection(collection) { return this._upsert('collections', collection.id, this._collectionRow(collection)); }
  async deleteTicket(id) { return this._delete('tickets', id); }
  async deleteExpense(id) { return this._delete('expenses', id); }
  async deleteCollection(id) { return this._delete('collections', id); }

  // ─── OFFLINE QUEUE ──────────────────────────────────────────────────

  queueItem(tableName, localId, data, op = 'upsert') {
    try {
      this.storage.db.run(
        `INSERT OR REPLACE INTO sync_queue (table_name, local_id, data, op) VALUES (?, ?, ?, ?)`,
        [tableName, localId, JSON.stringify(data), op]
      );
      this.storage.save();
    } catch (error) {
      console.error('☁️ Failed to queue sync item:', error.message);
    }
  }

  /** Send everything waiting in the queue (50 at a time). */
  async processQueue() {
    if (this.syncing || !this.enabled || !this.locationId) return;
    this.syncing = true;
    try {
      const result = this.storage.db.exec('SELECT id, table_name, local_id, data, op FROM sync_queue ORDER BY id LIMIT 50');
      if (!result.length || !result[0].values.length) return;
      const processed = [];
      for (const [id, tableName, localId, dataJson, op] of result[0].values) {
        try {
          let error;
          if (op === 'delete') {
            ({ error } = await this.supabase.from(tableName).delete().eq('location_id', this.locationId).eq('local_id', localId));
          } else {
            const data = { ...JSON.parse(dataJson), location_id: this.locationId };
            ({ error } = await this.supabase.from(tableName).upsert(data, { onConflict: 'location_id,local_id' }));
          }
          if (error) { this.lastError = describeError(error); continue; }
          processed.push(id);
        } catch (e) {
          this.lastError = describeError(e);
          this.online = false;
          break; // still offline
        }
      }
      if (processed.length > 0) {
        this.storage.db.run(`DELETE FROM sync_queue WHERE id IN (${processed.join(',')})`);
        this.storage.save();
        this.lastSyncAt = new Date().toISOString();
        this.online = true;
        console.log(`☁️ Synced ${processed.length} queued items`);
      }
    } catch (_) {
      // retry on the next tick
    } finally {
      this.syncing = false;
    }
  }

  queueSize() {
    try {
      const result = this.storage.db.exec('SELECT COUNT(*) FROM sync_queue');
      if (result.length) return result[0].values[0][0];
    } catch (_) {}
    return 0;
  }

  // ─── Heartbeat and dashboard "test connection" ping ─────────────────

  async heartbeat() {
    if (!this.enabled || !this.locationId || !this.supabase) return;
    const now = new Date().toISOString();
    let info = null;
    try { info = this.options.getDeviceInfo ? this.options.getDeviceInfo() : null; } catch (_) {}
    const { error } = await this.supabase.from('locations').update({
      last_seen_at: now,
      app_version: this.options.appVersion || null,
      queue_size: this.queueSize(),
      last_sync_at: this.lastSyncAt,
      last_error: this.lastError,
      device_info: info
    }).eq('id', this.locationId);
    if (error) {
      this.online = false;
      this.lastError = describeError(error);
      return;
    }
    this.online = true;
    this.lastHeartbeatAt = now;
    // Did the dashboard ask for a connection test?
    const { data } = await this.supabase.from('locations').select('ping_requested_at,ping_reply_at').eq('id', this.locationId).maybeSingle();
    if (data && data.ping_requested_at && (!data.ping_reply_at || data.ping_requested_at > data.ping_reply_at)) {
      await this.supabase.from('locations').update({ ping_reply_at: new Date().toISOString() }).eq('id', this.locationId);
    }
  }

  // ─── Full comparison with the cloud ─────────────────────────────────

  async _fetchCloudIds(table, columns) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.supabase.from(table).select(columns)
        .eq('location_id', this.locationId).order('local_id', { ascending: true }).range(from, from + page - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < page) break;
    }
    return out;
  }

  /**
   * Make the cloud copy of this location equal to the local data: send what is missing
   * or different, delete what no longer exists here (deleted, refunded, cancelled).
   * @returns {{ok:boolean, tables:object, error?:string}}
   */
  async reconcile() {
    if (!this.enabled || !this.locationId || this.reconciling) return { ok: false, error: 'not-ready' };
    if (!this.options.getLocalRows) return { ok: false, error: 'no-local-rows' };
    this.reconciling = true;
    const summary = {};
    try {
      const local = this.options.getLocalRows();
      const cfg = {
        tickets: { rowFn: (r) => this._ticketRow(r), cols: 'local_id,price,date,time,category_name,serial_number,year' },
        expenses: { rowFn: (r) => this._expenseRow(r), cols: 'local_id,amount,date,time,description' },
        collections: { rowFn: (r) => this._collectionRow(r), cols: 'local_id,amount,date,time,notes' }
      };
      for (const table of TABLES) {
        const rows = (local[table] || []).map(cfg[table].rowFn);
        const cloud = await this._fetchCloudIds(table, cfg[table].cols);
        const cloudById = new Map(cloud.map(r => [r.local_id, r]));
        const localIds = new Set(rows.map(r => r.local_id));
        const norm = (v) => (v == null ? '' : String(v));
        const same = (c, r) => Object.keys(r).every(k => k === 'location_id'
          || ((k === 'price' || k === 'amount') ? Number(c[k]) === Number(r[k]) : norm(c[k]) === norm(r[k])));
        const toSend = rows.filter(r => { const c = cloudById.get(r.local_id); return !c || !same(c, r); });
        const toDelete = cloud.filter(c => !localIds.has(c.local_id)).map(c => c.local_id);
        for (let i = 0; i < toSend.length; i += 500) {
          const { error } = await this.supabase.from(table).upsert(toSend.slice(i, i + 500), { onConflict: 'location_id,local_id' });
          if (error) throw error;
        }
        for (let i = 0; i < toDelete.length; i += 200) {
          const { error } = await this.supabase.from(table).delete().eq('location_id', this.locationId).in('local_id', toDelete.slice(i, i + 200));
          if (error) throw error;
        }
        summary[table] = { local: rows.length, cloud: cloud.length, sent: toSend.length, removed: toDelete.length };
      }
      // Everything is now equal: pending queue items are obsolete.
      this.storage.db.run('DELETE FROM sync_queue');
      this.storage.save();
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      this.lastReconcile = { at: this.lastSyncAt, summary };
      return { ok: true, tables: summary };
    } catch (error) {
      this.lastError = describeError(error);
      return { ok: false, error: this.lastError, tables: summary };
    } finally {
      this.reconciling = false;
    }
  }

  /** Delete every cloud row of this location (used when the data is wiped). */
  async wipeCloud() {
    if (!this.supabase || !this.locationId) return { ok: false, error: 'not-connected' };
    try {
      const removed = {};
      for (const table of TABLES) {
        const { data, error } = await this.supabase.from(table).delete().eq('location_id', this.locationId).select('local_id');
        if (error) throw error;
        removed[table] = data ? data.length : 0;
      }
      this.storage.db.run('DELETE FROM sync_queue');
      this.storage.save();
      return { ok: true, removed };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /** Compare with the cloud shortly after something was deleted / edited / refunded / wiped. */
  scheduleReconcile(ms = 4000) {
    if (!this.enabled) return;
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    this._reconcileTimer = setTimeout(() => { this._reconcileTimer = null; this.reconcile().catch(() => {}); }, ms);
    if (this._reconcileTimer.unref) this._reconcileTimer.unref();
  }

  // ─── STATUS & CLEANUP ───────────────────────────────────────────────

  getStatus() {
    return {
      enabled: this.enabled,
      online: this.online,
      locationId: this.locationId,
      locationName: this.storage.getSetting('location_name'),
      queueSize: this.queueSize(),
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastReconcile: this.lastReconcile
    };
  }

  async stop() {
    this._clearTimers();
    if (this._reconcileTimer) { clearTimeout(this._reconcileTimer); this._reconcileTimer = null; }
    this.enabled = false;
    this.online = false;
  }
}

CloudSync.describeError = describeError;
module.exports = CloudSync;
