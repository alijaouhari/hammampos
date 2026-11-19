/**
 * HammamPOS - StorageManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * SQLite Database Layer - Handles all database operations for HammamPOS
 * REQ-2: Data Architecture (SQLite as master storage)
 * Using sql.js (SQLite compiled to WebAssembly - no build tools needed)
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class StorageManager {
  constructor(dbPath = null) {
    // Store database in user's AppData so it survives app updates
    const appDataDir = path.join(process.env.APPDATA || process.env.HOME, 'HammamPOS');
    this.dbPath = dbPath || path.join(appDataDir, 'hammampos.db');
    
    // NOTE: the old "copy ./data/hammampos.db into AppData when missing" migration was
    // removed on purpose. On a fresh install it could resurrect an old database that
    // happened to sit next to the program, which looked like "the wipe did not work".
    this.db = null;
    this.SQL = null;
  }

  /**
   * Initialize database connection and create tables
   */
  async initialize() {
    try {
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this.SQL = await initSqlJs();

      if (fs.existsSync(this.dbPath)) {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(buffer);
        this._rememberFileState();
        console.log('✅ Database loaded');
      } else {
        this.db = new this.SQL.Database();
        console.log('✅ New database created');
      }
      
      this.db.run('PRAGMA foreign_keys = ON');
      this.createTables();
      this.save();
      
      return { success: true };
    } catch (error) {
      console.error('❌ Database init failed:', error);
      throw error;
    }
  }

  /**
   * Write the whole in-memory database to disk.
   * Safety (v2.8.29): the file is written to a temporary file then swapped in, so a
   * crash cannot leave a half-written database. If ANOTHER program (e.g. a second copy
   * of the app that was left open) changed the file since we last read or wrote it,
   * its version is kept as hammampos.overwritten-<time>.db before we write ours, and
   * the incident is logged (it shows in the diagnostics and on the dashboard).
   */
  save() {
    try {
      const buffer = Buffer.from(this.db.export());
      this._guardForeignChange();
      const tmp = this.dbPath + '.tmp';
      fs.writeFileSync(tmp, buffer);
      try {
        fs.renameSync(tmp, this.dbPath);
      } catch (_) {
        // Rename can fail on Windows if another program holds the file; write directly.
        fs.writeFileSync(this.dbPath, buffer);
        try { fs.unlinkSync(tmp); } catch (__) {}
      }
      this._rememberFileState();
      this._dailySnapshot();
    } catch (error) {
      console.error('❌ Save failed:', error);
    }
  }

  _rememberFileState() {
    try {
      const st = fs.statSync(this.dbPath);
      this._fileState = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (_) {
      this._fileState = null;
    }
  }

  _guardForeignChange() {
    if (!this._fileState || !fs.existsSync(this.dbPath)) return;
    const st = fs.statSync(this.dbPath);
    if (st.mtimeMs === this._fileState.mtimeMs && st.size === this._fileState.size) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const keep = this.dbPath.replace(/\.db$/i, '') + '.overwritten-' + stamp + '.db';
    try { fs.copyFileSync(this.dbPath, keep); } catch (_) {}
    this.lastConflict = { at: new Date().toISOString(), keptAs: keep, foreignSize: st.size, foreignMtime: new Date(st.mtimeMs).toISOString() };
    console.error('DB_CONFLICT: the database file was changed by another program (a second copy of the app?). Its version was kept in ' + keep);
  }

  /** Once per day, keep a copy of the database in snapshots/ (last 30 days). */
  _dailySnapshot() {
    try {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      if (this._snapshotDay === day) return;
      const dir = path.join(path.dirname(this.dbPath), 'snapshots');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, day + '.db');
      if (!fs.existsSync(file)) fs.copyFileSync(this.dbPath, file);
      this._snapshotDay = day;
      const all = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      all.slice(0, Math.max(0, all.length - 30)).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} });
    } catch (error) {
      console.warn('Snapshot failed:', error.message);
    }
  }

  /** Snapshot files on disk (name, size) and the overwritten copies, for diagnostics. */
  listSafetyCopies() {
    const dir = path.dirname(this.dbPath);
    const out = { snapshots: [], overwritten: [] };
    try { out.snapshots = fs.readdirSync(path.join(dir, 'snapshots')).filter(f => f.endsWith('.db')).sort(); } catch (_) {}
    try { out.overwritten = fs.readdirSync(dir).filter(f => /\.overwritten-.*\.db$/.test(f)).sort(); } catch (_) {}
    return out;
  }

  /**
   * Per-day evidence for the last `days` days: tickets in the database and audit-log
   * activity, plus tickets per month for the last 14 months. Used to find lost days.
   */
  getHistoryDiagnostics(days = 75) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const map = (sql, params) => {
      const r = this.db.exec(sql, params);
      const o = {};
      if (r[0]) r[0].values.forEach(([k, v]) => { o[k] = v; });
      return o;
    };
    return {
      since,
      ticketsPerDay: map('SELECT date, COUNT(*) FROM tickets WHERE date >= ? GROUP BY date ORDER BY date', [since]),
      auditPerDay: map("SELECT substr(timestamp,1,10), COUNT(*) FROM audit_log WHERE timestamp >= ? GROUP BY 1 ORDER BY 1", [since]),
      ticketsPerMonth: map("SELECT substr(date,1,7), COUNT(*) FROM tickets GROUP BY 1 ORDER BY 1 DESC LIMIT 14", []),
      clearEvents: map("SELECT timestamp, details FROM audit_log WHERE action LIKE 'CLEAR_ALL_DATA%' ORDER BY id DESC LIMIT 10", [])
    };
  }

  createTables() {
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert default settings if they don't exist
    const defaultSettings = [
      ['hammam_name', 'حمام'],
      ['admin_password', '1234'], // Default password
      ['printer_name', ''],
      ['email_enabled', 'false'],
      ['email_address', ''],
      ['email_password', ''],
      ['email_smtp_host', ''],
      ['email_smtp_port', '587']
    ];
    
    defaultSettings.forEach(([key, value]) => {
      const existing = this.db.exec('SELECT value FROM settings WHERE key = ?', [key]);
      if (existing.length === 0 || existing[0].values.length === 0) {
        this.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
      }
    });

    this.db.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL,
      active INTEGER DEFAULT 1, serial_counter INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, serial_number INTEGER NOT NULL, year INTEGER NOT NULL,
      category_id INTEGER NOT NULL, category_name TEXT NOT NULL, price REAL NOT NULL,
      date TEXT NOT NULL, time TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, amount REAL NOT NULL,
      date TEXT NOT NULL, time TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL NOT NULL, date TEXT NOT NULL,
      time TEXT NOT NULL, notes TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Days included in a money collection. A collection can cover multiple days;
    // a day that appears here has already been collected and must not be offered again.
    this.db.run(`CREATE TABLE IF NOT EXISTS collection_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
      total_tickets INTEGER NOT NULL, total_revenue REAL NOT NULL, total_expenses REAL NOT NULL,
      net_revenue REAL NOT NULL, cash_in_hand REAL NOT NULL, category_breakdown TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entity TEXT NOT NULL,
      entity_id INTEGER, details TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS serial_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL,
      reset_date TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, subject TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sync_type TEXT NOT NULL, status TEXT NOT NULL,
      last_sync TEXT, error TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Day status table — tracks status for days (working, holiday, repair)
    this.db.run(`CREATE TABLE IF NOT EXISTS day_status (
      date TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'working',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Change float table — teller change money held separately from sales/expenses/collections
    // operation: 'add' (owner gives teller money) | 'take' (owner takes money back)
    // This is NOT revenue, NOT an expense, NOT a collection. It never affects getCashInHand().
    this.db.run(`CREATE TABLE IF NOT EXISTS change_float (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      note TEXT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Expense payment-model migration (idempotent; ADD COLUMN throws if the column
    // already exists, so each is guarded). This separates WHEN an expense occurred
    // (the existing `date` column = "expense day") from WHETHER/WHEN/HOW it was paid.
    // Existing rows keep the pre-migration meaning "recorded = paid from business
    // cash on `date`": paid=1, payment_source='cash', and paid_date defaults to the
    // expense `date`. This preserves all historical cash math (getCashInHand still
    // subtracts them) with no data rewrite.
    //   paid           1 = paid, 0 = unpaid/outstanding
    //   paid_date      the day the expense was actually paid (may differ from `date`)
    //   payment_source 'cash' (business cash) | 'out_of_pocket' (owner paid personally)
    const expenseMigrations = [
      "ALTER TABLE expenses ADD COLUMN paid INTEGER DEFAULT 1",
      "ALTER TABLE expenses ADD COLUMN paid_date TEXT",
      "ALTER TABLE expenses ADD COLUMN payment_source TEXT DEFAULT 'cash'"
    ];
    for (const sql of expenseMigrations) {
      try { this.db.run(sql); } catch (_) { /* column already exists */ }
    }
    // Backfill paid_date for pre-existing paid rows so their "paid day" equals their
    // expense day (they were treated as paid-on-entry before this migration existed).
    // Only touches rows where the new column is still NULL — safe to run every boot.
    try {
      this.db.run("UPDATE expenses SET paid_date = date WHERE paid = 1 AND paid_date IS NULL");
    } catch (_) { /* columns not present yet on a brand-new table build order */ }

    // collection_days: add `amount` column so each day's allocation within a
    // multi-day collection can be stored individually (required for repeat/partial
    // collection of the same date across multiple collection events). Migration is
    // guarded — existing rows get DEFAULT 0 (legacy rows have no per-day split).
    try { this.db.run("ALTER TABLE collection_days ADD COLUMN amount REAL DEFAULT 0"); } catch (_) {}

    // Refunds (money system): a refunded ticket stays on record but no longer counts
    // as income anywhere (daily summary, zakat, today's counters, cash in hand).
    try { this.db.run("ALTER TABLE tickets ADD COLUMN refunded_at TEXT"); } catch (_) {}
    try { this.db.run("ALTER TABLE tickets ADD COLUMN refund_reason TEXT"); } catch (_) {}

    // zakat_tracking: one row per collection_days row, stores the set-aside status
    // for the owner's personal Zakat tracking. NEVER touched by financial queries.
    this.db.run(`CREATE TABLE IF NOT EXISTS zakat_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_day_id INTEGER NOT NULL UNIQUE,
      set_aside INTEGER DEFAULT 0,
      set_aside_at TEXT,
      FOREIGN KEY (collection_day_id) REFERENCES collection_days(id)
    )`);

    // zakat_days: per-calendar-day Zakat set-aside flag. Zakat = 2.5% of that day's
    // ticket income (not profit, independent of collections). Informational only.
    this.db.run(`CREATE TABLE IF NOT EXISTS zakat_days (
      date TEXT PRIMARY KEY,
      set_aside INTEGER NOT NULL DEFAULT 0,
      set_aside_at TEXT
    )`);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_date ON tickets(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_year ON tickets(year)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_paid ON expenses(paid)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_collections_date ON collections(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_collection_days_date ON collection_days(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_collection_days_collection ON collection_days(collection_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_change_float_date ON change_float(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
  }

  /**
   * Settings Management
   */
  getSetting(key, defaultValue = null) {
    const result = this.db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return defaultValue;
  }

  setSetting(key, value) {
    this.db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))", [key, value]);
    this.save();
  }

  getAllSettings() {
    const result = this.db.exec(`SELECT key, value FROM settings`);
    const settings = {};
    if (result.length > 0) {
      result[0].values.forEach(([key, value]) => {
        settings[key] = value;
      });
    }
    return settings;
  }

  /**
   * Admin Authentication
   */
  verifyAdminPassword(password) {
    const storedPassword = this.getSetting('admin_password');
    // Support both legacy plaintext and bcrypt hashed passwords
    if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$')) {
      return bcrypt.compareSync(password, storedPassword);
    }
    // Legacy plaintext — verify and upgrade to bcrypt
    if (password === storedPassword) {
      this.changeAdminPassword(password); // re-save as hash
      return true;
    }
    return false;
  }

  changeAdminPassword(newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    this.setSetting('admin_password', hash);
  }

  // ── Admin password recovery ───────────────────────────────────────────
  // Two ways to reset the admin password without knowing it:
  //   1. Recovery key (offline): XXXX-XXXX-XXXX-XXXX, shown once, only its bcrypt
  //      hash is stored.
  //   2. Emailed 6-digit code, valid 15 minutes, single use, only its hash is stored.
  // Failed attempts on either share one counter: 5 failures lock recovery for 15 min.
  static get RECOVERY_MAX_FAILS() { return 5; }
  static get RECOVERY_LOCK_MS() { return 15 * 60 * 1000; }
  static get RESET_CODE_TTL_MS() { return 15 * 60 * 1000; }
  static get RESET_CODE_MIN_GAP_MS() { return 60 * 1000; }

  getRecoveryLockMs() {
    const until = parseInt(this.getSetting('recovery_locked_until', '0'), 10) || 0;
    return Math.max(0, until - Date.now());
  }

  _recordRecoveryFailure() {
    const count = (parseInt(this.getSetting('recovery_fail_count', '0'), 10) || 0) + 1;
    if (count >= StorageManager.RECOVERY_MAX_FAILS) {
      this.setSetting('recovery_locked_until', String(Date.now() + StorageManager.RECOVERY_LOCK_MS));
      this.setSetting('recovery_fail_count', '0');
      this.logAudit('SECURITY', 'recovery', null, 'Recovery locked after too many failed attempts');
      return { locked: true, attemptsLeft: 0 };
    }
    this.setSetting('recovery_fail_count', String(count));
    return { locked: false, attemptsLeft: StorageManager.RECOVERY_MAX_FAILS - count };
  }

  _clearRecoveryFailures() {
    this.setSetting('recovery_fail_count', '0');
    this.setSetting('recovery_locked_until', '0');
  }

  hasRecoveryKey() {
    return !!this.getSetting('recovery_key_hash', '');
  }

  /** Creates (or replaces) the recovery key. Returns the plain key ONCE. */
  generateRecoveryKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
    const bytes = crypto.randomBytes(16);
    let raw = '';
    for (let i = 0; i < 16; i++) raw += alphabet[bytes[i] % 32]; // 256 % 32 == 0: unbiased
    this.setSetting('recovery_key_hash', bcrypt.hashSync(raw, 10));
    this.logAudit('SECURITY', 'recovery', null, 'Recovery key generated');
    return raw.match(/.{4}/g).join('-');
  }

  verifyRecoveryKey(key) {
    const lock = this.getRecoveryLockMs();
    if (lock > 0) return { ok: false, reason: 'locked', retryAfterMs: lock };
    const hash = this.getSetting('recovery_key_hash', '');
    if (!hash) return { ok: false, reason: 'no_key' };
    const norm = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm.length === 16 && bcrypt.compareSync(norm, hash)) {
      this._clearRecoveryFailures();
      return { ok: true };
    }
    const f = this._recordRecoveryFailure();
    return f.locked
      ? { ok: false, reason: 'locked', retryAfterMs: StorageManager.RECOVERY_LOCK_MS }
      : { ok: false, reason: 'invalid_key', attemptsLeft: f.attemptsLeft };
  }

  /** Creates a 6-digit reset code (one request per minute). Returns the plain code to email. */
  createResetCode() {
    const lock = this.getRecoveryLockMs();
    if (lock > 0) return { ok: false, reason: 'locked', retryAfterMs: lock };
    const last = parseInt(this.getSetting('reset_code_requested_at', '0'), 10) || 0;
    const wait = StorageManager.RESET_CODE_MIN_GAP_MS - (Date.now() - last);
    if (wait > 0) return { ok: false, reason: 'throttled', retryAfterMs: wait };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.setSetting('reset_code_hash', bcrypt.hashSync(code, 10));
    this.setSetting('reset_code_expires', String(Date.now() + StorageManager.RESET_CODE_TTL_MS));
    this.setSetting('reset_code_requested_at', String(Date.now()));
    return { ok: true, code };
  }

  clearResetCode() {
    this.setSetting('reset_code_hash', '');
    this.setSetting('reset_code_expires', '0');
  }

  verifyResetCode(code) {
    const lock = this.getRecoveryLockMs();
    if (lock > 0) return { ok: false, reason: 'locked', retryAfterMs: lock };
    const hash = this.getSetting('reset_code_hash', '');
    if (!hash) return { ok: false, reason: 'no_code' };
    const expires = parseInt(this.getSetting('reset_code_expires', '0'), 10) || 0;
    if (Date.now() > expires) {
      this.clearResetCode();
      return { ok: false, reason: 'expired' };
    }
    const norm = String(code || '').replace(/\D/g, '');
    if (norm.length === 6 && bcrypt.compareSync(norm, hash)) {
      this.clearResetCode(); // single use
      this._clearRecoveryFailures();
      return { ok: true };
    }
    const f = this._recordRecoveryFailure();
    return f.locked
      ? { ok: false, reason: 'locked', retryAfterMs: StorageManager.RECOVERY_LOCK_MS }
      : { ok: false, reason: 'invalid_code', attemptsLeft: f.attemptsLeft };
  }

  /** Reset with the recovery key. On success the key is rotated; the new key is returned once. */
  resetAdminPasswordWithKey(key, newPassword) {
    if (!newPassword || String(newPassword).length < 4) return { ok: false, reason: 'weak' };
    const v = this.verifyRecoveryKey(key);
    if (!v.ok) return v;
    this.changeAdminPassword(newPassword);
    this.logAudit('SECURITY', 'admin_password', null, 'Admin password reset with recovery key');
    return { ok: true, newRecoveryKey: this.generateRecoveryKey() };
  }

  /** Reset with the emailed code. */
  resetAdminPasswordWithCode(code, newPassword) {
    if (!newPassword || String(newPassword).length < 4) return { ok: false, reason: 'weak' };
    const v = this.verifyResetCode(code);
    if (!v.ok) return v;
    this.changeAdminPassword(newPassword);
    this.logAudit('SECURITY', 'admin_password', null, 'Admin password reset with emailed code');
    return { ok: true };
  }

  /**
   * Update multiple settings at once
   */
  updateSettings(settings) {
    Object.keys(settings).forEach(key => {
      this.setSetting(key, settings[key]);
    });
    return true;
  }

  /**
   * Categories Management
   */
  getCategories(activeOnly = true) {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = activeOnly 
      ? 'SELECT * FROM categories WHERE active = 1 ORDER BY id'
      : 'SELECT * FROM categories ORDER BY id';
    const result = this.db.exec(sql);
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    const categories = result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      
      // Get today's count for this category
      const countResult = this.db.exec('SELECT COUNT(*) as count FROM tickets WHERE category_id = ? AND date = ? AND refunded_at IS NULL', [obj.id, today]);
      obj.today_count = countResult[0]?.values[0]?.[0] || 0;
      
      return obj;
    });
    
    return categories;
  }

  addCategory(name, price) {
    this.db.run('INSERT INTO categories (name, price, active, serial_counter) VALUES (?, ?, 1, 0)', [name, price]);
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    this.logAudit('CREATE', 'categories', id, `${name} - ${price}dh`);
    this.save();
    return id;
  }

  updateCategory(id, name, price) {
    this.db.run('UPDATE categories SET name = ?, price = ? WHERE id = ?', [name, price, id]);
    this.logAudit('UPDATE', 'categories', id, `${name} - ${price}dh`);
    this.save();
    return true;
  }

  toggleCategory(id, active) {
    this.db.run('UPDATE categories SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    this.logAudit('UPDATE', 'categories', id, `active = ${active}`);
    this.save();
    return true;
  }

  /**
   * Tickets Management
   */
  createTicket(categoryId) {
    const catResult = this.db.exec('SELECT * FROM categories WHERE id = ?', [categoryId]);
    if (!catResult[0]) throw new Error('Category not found');
    
    const cols = catResult[0].columns;
    const row = catResult[0].values[0];
    const category = {};
    cols.forEach((col, i) => category[col] = row[i]);

    const now = new Date();
    const year = now.getFullYear();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];

    const newSerial = category.serial_counter + 1;
    console.log(`📝 Creating ticket for ${category.name}: serial ${category.serial_counter} → ${newSerial}`);
    
    this.db.run('UPDATE categories SET serial_counter = ? WHERE id = ?', [newSerial, categoryId]);

    this.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [newSerial, year, categoryId, category.name, category.price, date, time]);

    const result = this.db.exec('SELECT last_insert_rowid()');
    const ticketId = result[0].values[0][0];

    const ticket = {
      id: ticketId,
      serial_number: newSerial,
      year,
      category_id: categoryId,
      category_name: category.name,
      price: category.price,
      date,
      time
    };

    this.logAudit('CREATE', 'tickets', ticketId, `${category.name} - ${newSerial}/${year}`);
    this.save(); // IMPORTANT: Save to disk after updating serial counter
    
    console.log(`✅ Ticket created: ${category.name}-${newSerial}/${year}`);
    return ticket;
  }

  getTickets(startDate, endDate = null) {
    const sql = endDate
      ? 'SELECT * FROM tickets WHERE date BETWEEN ? AND ? ORDER BY timestamp DESC'
      : 'SELECT * FROM tickets WHERE date = ? ORDER BY timestamp DESC';
    
    const params = endDate ? [startDate, endDate] : [startDate];
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  getTodayTickets() {
    const today = new Date().toISOString().split('T')[0];
    return this.getTickets(today).filter(t => !t.refunded_at);
  }

  getTicketsForDate(date) {
    const result = this.db.exec(`
      SELECT id, serial_number, year, category_name, price, time, timestamp, refunded_at, refund_reason
      FROM tickets 
      WHERE date = ? 
      ORDER BY time ASC
    `, [date]);
    
    const tickets = [];
    if (result.length > 0) {
      result[0].values.forEach(row => {
        const [id, serial, year, category, price, time, timestamp, refunded_at, refund_reason] = row;
        tickets.push({
          id,
          serial_number: serial,
          year,
          category_name: category,
          price,
          time,
          timestamp,
          refunded_at,
          refund_reason
        });
      });
    }
    
    return tickets;
  }

  /**
   * Expenses Management
   */
  // Low-level primitive. BACKWARD-COMPATIBLE: called with (description, amount) it
  // behaves exactly as before — a paid, business-cash expense stamped with today's
  // date. The optional `opts` object lets callers (recordExpense / payExpense) set a
  // historical expense day, an unpaid state, a payment source, or a paid date without
  // changing any existing caller (wood/template payment, older tests).
  //   opts.date          'YYYY-MM-DD' expense day (default: today)
  //   opts.time          'HH:MM:SS' (default: now)
  //   opts.paid          true/1 = paid, false/0 = unpaid (default: paid)
  //   opts.paymentSource 'cash' | 'out_of_pocket' (default: 'cash')
  //   opts.paidDate      'YYYY-MM-DD' the day it was paid (default: expense day when
  //                      paid; null when unpaid)
  addExpense(description, amount, opts = {}) {
    const now = new Date();
    const date = opts.date || now.toISOString().split('T')[0];
    const time = opts.time || now.toTimeString().split(' ')[0];

    // Default = paid (preserves legacy "recorded = paid" for existing callers).
    const isPaid = (opts.paid === undefined) ? true
      : (opts.paid === true || opts.paid === 1 || opts.paid === '1');
    const rawSource = opts.paymentSource === 'out_of_pocket' ? 'out_of_pocket' : 'cash';
    // A never-paid expense has no source yet; store 'cash' placeholder but paid=0.
    const paidDate = isPaid ? (opts.paidDate || date) : null;

    this.db.run(
      'INSERT INTO expenses (description, amount, date, time, paid, paid_date, payment_source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [description, amount, date, time, isPaid ? 1 : 0, paidDate, rawSource]
    );

    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];

    this.logAudit('CREATE', 'expenses', id,
      `${description} - ${amount}dh - ${isPaid ? ('paid/' + rawSource) : 'unpaid'} - day ${date}`);
    this.save();
    return id;
  }

  /**
   * Full-featured expense entry. Separates expense day / paid state / payment source.
   * Real-world workflows supported:
   *  - known + paid now (cash or out-of-pocket)
   *  - known but unpaid (recorded, no cash movement, payable later)
   *  - historical/back-dated expense day (does NOT get overwritten with today)
   * Cash only decreases for expenses that are paid AND paid from business cash
   * (enforced centrally in getCashInHand), so unpaid/out-of-pocket entries never
   * move business cash here.
   * @returns {{success:boolean, id?:number, error?:string}}
   */
  recordExpense(opts = {}) {
    const description = (opts.description == null ? '' : String(opts.description)).trim();
    const amount = Number(opts.amount);
    if (!description) return { success: false, error: 'وصف المصروف مطلوب' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'المبلغ غير صالح' };

    const today = new Date().toISOString().split('T')[0];
    const expenseDay = (opts.date && String(opts.date).trim()) ? String(opts.date).trim() : today;

    const isPaid = (opts.paid === true || opts.paid === 1 || opts.paid === '1');
    const paymentSource = opts.paymentSource === 'out_of_pocket' ? 'out_of_pocket' : 'cash';
    // Paid day is only meaningful when paid; defaults to today (the day the payment
    // is being recorded), NOT the expense day, unless the caller specifies one.
    const paidDate = isPaid ? (opts.paidDate || today) : null;

    const id = this.addExpense(description, amount, {
      date: expenseDay,
      paid: isPaid,
      paymentSource,
      paidDate
    });
    return { success: true, id };
  }

  /**
   * Pay a previously-unpaid expense. Preserves the original expense day; records the
   * paid day + payment source. Mirrors payWoodPurchase: a given expense can be paid
   * exactly once — an already-paid expense is rejected with no cash movement and no
   * mutation of the existing paid_date/source.
   * @param {number} expenseId
   * @param {{paidDate?:string, paymentSource?:string}} opts
   * @returns {{success:boolean, error?:string}}
   */
  payExpense(expenseId, opts = {}) {
    const result = this.db.exec('SELECT * FROM expenses WHERE id = ?', [expenseId]);
    if (!result[0] || result[0].values.length === 0) {
      return { success: false, error: 'المصروف غير موجود' };
    }
    const cols = result[0].columns;
    const ex = {};
    cols.forEach((col, i) => ex[col] = result[0].values[0][i]);

    if (Number(ex.paid) === 1) {
      return { success: false, error: 'تم دفع هذا المصروف مسبقاً' };
    }

    const payDate = (opts.paidDate && String(opts.paidDate).trim())
      ? String(opts.paidDate).trim()
      : new Date().toISOString().split('T')[0];
    const paymentSource = opts.paymentSource === 'out_of_pocket' ? 'out_of_pocket' : 'cash';

    // Expense day (`date`) is intentionally NOT touched.
    this.db.run(
      'UPDATE expenses SET paid = 1, paid_date = ?, payment_source = ? WHERE id = ?',
      [payDate, paymentSource, expenseId]
    );
    this.logAudit('UPDATE', 'expenses', expenseId,
      `paid ${ex.amount}dh on ${payDate} via ${paymentSource} (expense day ${ex.date})`);
    this.save();
    return { success: true };
  }

  getExpense(id) {
    const result = this.db.exec('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!result[0] || result[0].values.length === 0) return null;
    const cols = result[0].columns;
    const obj = {};
    cols.forEach((col, i) => obj[col] = result[0].values[0][i]);
    return obj;
  }

  getExpenses(startDate, endDate = null) {
    const sql = endDate
      ? 'SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY timestamp DESC'
      : 'SELECT * FROM expenses WHERE date = ? ORDER BY timestamp DESC';
    
    const params = endDate ? [startDate, endDate] : [startDate];
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  getExpensesForDate(date) {
    const result = this.db.exec(`
      SELECT id, description, amount, time, timestamp, paid, paid_date, payment_source
      FROM expenses 
      WHERE date = ? 
      ORDER BY time ASC
    `, [date]);
    
    const expenses = [];
    if (result.length > 0) {
      result[0].values.forEach(row => {
        const [id, description, amount, time, timestamp, paid, paid_date, payment_source] = row;
        expenses.push({
          id,
          description,
          amount,
          time,
          timestamp,
          paid,
          paid_date,
          payment_source
        });
      });
    }
    
    return expenses;
  }

  /**
   * Outstanding (unpaid) expenses, newest expense-day first. Mirrors
   * getOutstandingWoodPurchases so the UI can surface payable expenses.
   */
  getOutstandingExpenses() {
    const result = this.db.exec(
      'SELECT * FROM expenses WHERE paid = 0 ORDER BY date DESC, timestamp DESC'
    );
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Collections Management
   */
  collectMoney(amount, notes = '') {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];

    this.db.run('INSERT INTO collections (amount, date, time, notes) VALUES (?, ?, ?, ?)', 
      [amount, date, time, notes]);
    
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    
    this.logAudit('CREATE', 'collections', id, `${amount}dh`);
    this.save();
    return id;
  }

  /**
   * Collect money for a specific set of days, persisting the day associations
   * atomically with the collection. The collection row and its collection_days
   * rows are written together; nothing is persisted to disk (save()) unless all
   * inserts succeed. On failure the in-memory rows are rolled back and the error
   * is rethrown, so no partial collection is ever recorded.
   * @param {number} amount - total collected (must equal sum of dayAmounts values)
   * @param {string} notes
   * @param {string[]} days - array of 'YYYY-MM-DD' dates included in this collection
   * @param {Object} [dayAmounts] - map of date → amount allocated from that date.
   *   If omitted/incomplete, the total is distributed evenly across the days (legacy
   *   path). This enables per-date Zakat tracking and partial re-collection of a date.
   * @returns {{id,amount,notes,date,time,days}}
   */
  collectMoneyForDays(amount, notes = '', days = [], dayAmounts = {}) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];

    // Normalize + de-duplicate the incoming days; ignore empties.
    const uniqueDays = Array.from(new Set((days || [])
      .map(d => (d == null ? '' : String(d).trim()))
      .filter(d => d.length > 0)));

    let id = null;
    try {
      this.db.run('INSERT INTO collections (amount, date, time, notes) VALUES (?, ?, ?, ?)',
        [amount, date, time, notes || '']);
      id = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];

      for (const d of uniqueDays) {
        // Per-day amount: use supplied value if valid, else distribute evenly.
        const dayAmt = (dayAmounts && Number.isFinite(Number(dayAmounts[d])) && Number(dayAmounts[d]) > 0)
          ? Number(dayAmounts[d])
          : (uniqueDays.length > 0 ? Math.round((amount / uniqueDays.length) * 100) / 100 : 0);
        this.db.run('INSERT INTO collection_days (collection_id, date, amount) VALUES (?, ?, ?)', [id, d, dayAmt]);
      }

      this.logAudit('CREATE', 'collections', id, `${amount}dh (${uniqueDays.length} days: ${uniqueDays.join(', ')})`);
      this.save();
    } catch (error) {
      // Roll back in-memory rows so no partial collection remains, then rethrow.
      try {
        if (id !== null) {
          this.db.run('DELETE FROM collection_days WHERE collection_id = ?', [id]);
          this.db.run('DELETE FROM collections WHERE id = ?', [id]);
        }
      } catch (_) {}
      throw error;
    }

    return { id, amount, notes: notes || '', date, time, days: uniqueDays };
  }

  /**
   * Return the set of dates that have already been collected (persisted in
   * collection_days). Used to exclude already-collected days from availability.
   * @returns {string[]} distinct collected dates
   */
  getCollectedDays() {
    const result = this.db.exec('SELECT DISTINCT date FROM collection_days ORDER BY date');
    if (!result[0]) return [];
    return result[0].values.map(row => row[0]);
  }

  /**
   * Return the days included in a specific collection.
   * @param {number} collectionId
   * @returns {string[]} dates for that collection (empty for legacy collections)
   */
  getCollectionDays(collectionId) {
    const result = this.db.exec('SELECT date FROM collection_days WHERE collection_id = ? ORDER BY date', [collectionId]);
    if (!result[0]) return [];
    return result[0].values.map(row => row[0]);
  }

  // Same as getCollectionDays but also returns per-day amounts (for the collection
  // details modal and Zakat tracking). amount=0 for legacy rows (no per-day split).
  getCollectionDaysWithAmounts(collectionId) {
    const result = this.db.exec(
      'SELECT id, date, COALESCE(amount, 0) as amount FROM collection_days WHERE collection_id = ? ORDER BY date',
      [collectionId]);
    if (!result[0]) return [];
    return result[0].values.map(row => ({ id: row[0], date: row[1], amount: row[2] }));
  }

  /**
   * Per-day cash-flow: cash that actually entered the drawer on date D.
   *   = SUM(ticket revenue on D)  −  SUM(cash-paid expenses whose paid_date = D)
   * Out-of-pocket, unpaid, and expense-day-dated amounts are ALL excluded because
   * they never moved physical cash on that day.
   * Used by the available-collection model; NOT used by getCashInHand (which sums
   * across all time — both are self-consistent).
   */
  getDayCashFlow(date) {
    const revR = this.db.exec(
      'SELECT COALESCE(SUM(price),0) FROM tickets WHERE date = ?', [date]);
    const revenue = revR[0] ? revR[0].values[0][0] : 0;

    const expR = this.db.exec(
      "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE paid=1 AND payment_source='cash' AND paid_date=?",
      [date]);
    const cashPaidExpenses = expR[0] ? expR[0].values[0][0] : 0;

    return { revenue, cashPaidExpenses, net: revenue - cashPaidExpenses };
  }

  /**
   * Total amount already collected from a specific date across ALL past collection
   * events. Uses collection_days.amount (the per-day allocation stored at collection
   * time). Legacy rows with amount=0 from before the migration are treated as 0.
   */
  getCollectedAmountForDate(date) {
    const r = this.db.exec(
      'SELECT COALESCE(SUM(amount),0) FROM collection_days WHERE date = ?', [date]);
    return r[0] ? r[0].values[0][0] : 0;
  }

  /**
   * Available collection amount for a date:
   *   available(D) = dayCashFlow(D).net − SUM(already collected from D)
   * A date appears as available when available > 0 (positive cash, partially or
   * fully uncollected). A date with available ≤ 0 is non-collectible but may still
   * be shown in the UI.
   * The same date CAN be collected multiple times as new cash accumulates (e.g.
   * Day 8: collect 600 → later +400 revenue → available = 400 again).
   */
  getAvailableAmountForDate(date) {
    const { net } = this.getDayCashFlow(date);
    const collected = this.getCollectedAmountForDate(date);
    return net - collected;
  }

  /**
   * Build the complete available-days list used by the Money Collection modal.
   * Returns all dates in the data window with their cash-flow breakdown, already-
   * collected total, available amount, and day status. The renderer decides which
   * are selectable (available > 0) and which are shown-but-disabled (available ≤ 0).
   * Limit defaults to 60 days (wider than the summary ledger's 30 days).
   */
  getAvailableCollectionDays(limit = 60) {
    const today = new Date().toISOString().split('T')[0];

    // Build window: all dates from earliest data date up to today.
    const earliestR = this.db.exec(`
      SELECT MIN(date) FROM (
        SELECT MIN(date) as date FROM tickets
        UNION ALL SELECT MIN(date) as date FROM expenses
        UNION ALL SELECT MIN(date) as date FROM collections
      ) WHERE date IS NOT NULL`);
    let earliest = today;
    if (earliestR[0] && earliestR[0].values[0][0]) earliest = earliestR[0].values[0][0];

    // Generate date list (today included — partial-day collection supported).
    const allDates = [];
    const start = new Date(earliest + 'T12:00:00');
    const end = new Date(today + 'T12:00:00');
    for (let d = new Date(end); d >= start; d.setDate(d.getDate() - 1)) {
      const iso = d.toISOString().split('T')[0];
      allDates.push(iso);
      if (allDates.length >= limit) break;
    }

    // Day status map
    const dsR = this.db.exec("SELECT date, status FROM day_status");
    const dsMap = {};
    if (dsR[0]) dsR[0].values.forEach(([dt, st]) => dsMap[dt] = st);

    // Per-date revenue and cash-paid expenses (by paid_date) — one pass.
    const revR = this.db.exec(
      'SELECT date, COALESCE(SUM(price),0) FROM tickets GROUP BY date');
    const revMap = {};
    if (revR[0]) revR[0].values.forEach(([dt, v]) => revMap[dt] = v);

    const expR = this.db.exec(
      "SELECT paid_date, COALESCE(SUM(amount),0) FROM expenses WHERE paid=1 AND payment_source='cash' GROUP BY paid_date");
    const expMap = {};
    if (expR[0]) expR[0].values.forEach(([dt, v]) => expMap[dt] = v);

    // Per-date already-collected totals.
    const colR = this.db.exec(
      'SELECT date, COALESCE(SUM(amount),0) FROM collection_days GROUP BY date');
    const colMap = {};
    if (colR[0]) colR[0].values.forEach(([dt, v]) => colMap[dt] = v);

    return allDates.map(date => {
      const revenue = revMap[date] || 0;
      const cashPaidExpenses = expMap[date] || 0;
      const net = revenue - cashPaidExpenses;
      const alreadyCollected = colMap[date] || 0;
      const available = net - alreadyCollected;
      return {
        date,
        revenue,
        cashPaidExpenses,
        net,
        alreadyCollected,
        available,
        day_status: dsMap[date] || null
      };
    });
  }

  getCollections(startDate = null, endDate = null) {
    let sql = 'SELECT * FROM collections';
    const params = [];
    
    if (startDate && endDate) {
      sql += ' WHERE date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else if (startDate) {
      sql += ' WHERE date = ?';
      params.push(startDate);
    }
    
    sql += ' ORDER BY timestamp DESC';
    
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  // ── Zakat tracking ────────────────────────────────────────────────────────
  // Zakat is informational/personal only. These methods NEVER affect getCashInHand,
  // collections, expenses, or any business financial calculation.

  /**
   * Get the set-aside status for a collection_days row.
   * Returns { setAside: bool, setAsideAt: string|null } or null if no record.
   */
  getZakatSetAside(collectionDayId) {
    const r = this.db.exec(
      'SELECT set_aside, set_aside_at FROM zakat_tracking WHERE collection_day_id = ?',
      [collectionDayId]);
    if (!r[0] || r[0].values.length === 0) return { setAside: false, setAsideAt: null };
    return { setAside: !!r[0].values[0][0], setAsideAt: r[0].values[0][1] };
  }

  /**
   * Mark (or unmark) a collection_days row's Zakat amount as set aside.
   * This is informational only — no cash or collection record is created.
   */
  setZakatSetAside(collectionDayId, setAside) {
    const flag = setAside ? 1 : 0;
    const at = setAside ? new Date().toISOString() : null;
    this.db.run(`
      INSERT INTO zakat_tracking (collection_day_id, set_aside, set_aside_at)
      VALUES (?, ?, ?)
      ON CONFLICT(collection_day_id) DO UPDATE SET set_aside = excluded.set_aside, set_aside_at = excluded.set_aside_at
    `, [collectionDayId, flag, at]);
    this.save();
    return { success: true };
  }

  /**
   * Get all Zakat records joined with their collection_days amounts for reporting.
   * Returns rows: { collection_day_id, date, collection_id, amount, set_aside, set_aside_at }
   * sorted newest-date first. Pure read — no financial effect.
   */
  getZakatHistory() {
    const r = this.db.exec(`
      SELECT cd.id, cd.date, cd.collection_id, cd.amount,
             COALESCE(zt.set_aside, 0) as set_aside,
             zt.set_aside_at
      FROM collection_days cd
      LEFT JOIN zakat_tracking zt ON zt.collection_day_id = cd.id
      WHERE cd.amount > 0
      ORDER BY cd.date DESC, cd.id DESC
    `);
    if (!r[0]) return [];
    const cols = r[0].columns;
    return r[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      obj.zakat = Math.round(obj.amount * 0.025 * 100) / 100; // 2.5% fixed
      return obj;
    });
  }

  /**
   * Two independent Zakat visibility settings (one per ledger table).
   * Keys: 'zakat_visible_sales_ledger' and 'zakat_visible_admin_ledger'.
   * Values: '1' = visible, '0' = hidden.
   */
  getZakatVisibility() {
    const keys = ['zakat_visible_sales_ledger', 'zakat_visible_admin_ledger'];
    const result = {};
    keys.forEach(k => { result[k] = this.getSetting(k, '0') === '1'; });
    return result;
  }

  /**
   * Day-based Zakat (2.5% of each day's ticket income). Informational only —
   * never touches cash, collections or any financial total.
   */
  setZakatDay(date, setAside) {
    const flag = setAside ? 1 : 0;
    const at = setAside ? new Date().toISOString() : null;
    this.db.run(`
      INSERT INTO zakat_days (date, set_aside, set_aside_at) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET set_aside = excluded.set_aside, set_aside_at = excluded.set_aside_at
    `, [date, flag, at]);
    this.save();
    return { success: true };
  }

  /** Dates (YYYY-MM-DD) whose Zakat has been marked as set aside. */
  getZakatSetAsideDates() {
    const r = this.db.exec('SELECT date FROM zakat_days WHERE set_aside = 1');
    return r[0] ? r[0].values.map(row => row[0]) : [];
  }

  /**
   * Every day that had ticket income, newest first, with its Zakat (2.5% of income)
   * and whether it was set aside. Days with no income have no Zakat and are omitted.
   */
  getZakatDaysHistory() {
    const r = this.db.exec(`
      SELECT t.date, SUM(t.price) AS revenue, COALESCE(z.set_aside, 0) AS set_aside
      FROM tickets t
      LEFT JOIN zakat_days z ON z.date = t.date
      WHERE t.refunded_at IS NULL
      GROUP BY t.date
      HAVING SUM(t.price) > 0
      ORDER BY t.date DESC
    `);
    if (!r[0]) return [];
    return r[0].values.map(row => ({
      date: row[0],
      revenue: row[1],
      zakat: Math.round(row[1] * 0.025 * 100) / 100,
      set_aside: row[2]
    }));
  }

  /**
   * Financial Calculations
   */
  getCashInHand() {
    // Calculate total revenue from all tickets
    const revenueResult = this.db.exec('SELECT COALESCE(SUM(price), 0) as total FROM tickets WHERE refunded_at IS NULL');
    const totalRevenue = revenueResult[0] ? revenueResult[0].values[0][0] : 0;

    // Calculate total expenses that actually left the business cash box. Only
    // expenses that are BOTH paid AND paid from business cash reduce cash-in-hand.
    // Unpaid expenses (outstanding) and out-of-pocket payments do NOT — they are
    // recorded obligations/spends that never moved the till. Legacy rows migrate to
    // paid=1 / payment_source='cash', so historical cash math is unchanged.
    const expensesResult = this.db.exec(
      "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE paid = 1 AND payment_source = 'cash'"
    );
    const totalExpenses = expensesResult[0] ? expensesResult[0].values[0][0] : 0;

    // Calculate total collections (money taken out)
    const collectionsResult = this.db.exec('SELECT COALESCE(SUM(amount), 0) as total FROM collections');
    const totalCollections = collectionsResult[0] ? collectionsResult[0].values[0][0] : 0;

    // Cash in hand = Revenue - (paid business-cash expenses) - Collections
    return totalRevenue - totalExpenses - totalCollections;
  }

  getLifetimeRevenue() {
    const result = this.db.exec('SELECT COALESCE(SUM(price), 0) as total FROM tickets WHERE refunded_at IS NULL');
    return result[0] ? result[0].values[0][0] : 0;
  }

  getStats() {
    const ticketsResult = this.db.exec('SELECT COUNT(*) as count FROM tickets');
    const totalTickets = ticketsResult[0] ? ticketsResult[0].values[0][0] : 0;
    
    const totalRevenue = this.getLifetimeRevenue();
    const cashInHand = this.getCashInHand();
    const categories = this.getCategories();

    return {
      totalTickets,
      totalRevenue,
      cashInHand,
      categoriesCount: categories.length
    };
  }

  /**
   * Daily Summary and Reports
   */
  /**
   * Earliest and latest dates the daily ledger can show (YYYY-MM-DD).
   * latest = max(today, newest data date), same upper bound the ledger window uses.
   */
  getLedgerDateBounds() {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const q = (fn) => this.db.exec(`
      SELECT ${fn}(date) FROM (
        SELECT ${fn}(date) as date FROM tickets
        UNION ALL SELECT ${fn}(date) FROM expenses
        UNION ALL SELECT ${fn}(date) FROM collections
      ) WHERE date IS NOT NULL
    `);
    const minRes = q('MIN');
    const maxRes = q('MAX');
    const earliest = (minRes.length && minRes[0].values[0][0]) || today;
    let latest = today;
    if (maxRes.length && maxRes[0].values[0][0] && maxRes[0].values[0][0] > latest) {
      latest = maxRes[0].values[0][0];
    }
    return { earliest, latest };
  }

  /**
   * @param {number} limit  number of days (newest first) when no range is given
   * @param {{start:string,end:string}|null} range  optional YYYY-MM-DD range (e.g. one month);
   *        clamped to the ledger's earliest/latest dates. When set, limit is ignored.
   */
  getDailySummariesWithDetails(limit = 30, range = null) {
    // First, get all active categories to build dynamic columns
    const categoriesResult = this.db.exec('SELECT name FROM categories WHERE active = 1 ORDER BY id');
    const categoryNames = categoriesResult[0] ? categoriesResult[0].values.map(row => row[0]) : [];
    
    // Today's date
    const today = new Date().toISOString().split('T')[0];
    
    // Find the earliest date in the application's data (tickets, expenses, or collections)
    const earliestResult = this.db.exec(`
      SELECT MIN(date) FROM (
        SELECT MIN(date) as date FROM tickets
        UNION ALL
        SELECT MIN(date) as date FROM expenses
        UNION ALL
        SELECT MIN(date) as date FROM collections
      ) WHERE date IS NOT NULL
    `);
    let earliestDate = today; // Default to today if no data exists
    if (earliestResult.length > 0 && earliestResult[0].values[0][0]) {
      earliestDate = earliestResult[0].values[0][0];
    }

    // Find the LATEST date in the application's data. The window must extend to the
    // most recent data date, not just the machine clock's "today": if a sale/expense
    // is dated after today (e.g. the device clock is behind, or a future-dated entry),
    // capping at today would silently drop those rows and blank the ledger. We anchor
    // the window's upper bound at max(today, latest data date).
    const latestResult = this.db.exec(`
      SELECT MAX(date) FROM (
        SELECT MAX(date) as date FROM tickets
        UNION ALL
        SELECT MAX(date) as date FROM expenses
        UNION ALL
        SELECT MAX(date) as date FROM collections
      ) WHERE date IS NOT NULL
    `);
    let windowEnd = today;
    if (latestResult.length > 0 && latestResult[0].values[0][0]) {
      const latestDate = latestResult[0].values[0][0];
      if (latestDate > windowEnd) windowEnd = latestDate; // string compare works for YYYY-MM-DD
    }
    
    // Generate all calendar dates from earliestDate to windowEnd (inclusive), newest first.
    const allDates = [];
    let startDate = new Date(earliestDate + 'T12:00:00');
    let endDate = new Date(windowEnd + 'T12:00:00');
    let maxDays = limit;
    if (range && range.start && range.end) {
      // Month (or other) range: clamp to the days the ledger actually covers.
      const rangeStart = new Date(range.start + 'T12:00:00');
      const rangeEnd = new Date(range.end + 'T12:00:00');
      if (rangeStart > startDate) startDate = rangeStart;
      if (rangeEnd < endDate) endDate = rangeEnd;
      maxDays = Infinity;
    }
    for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      allDates.push(`${yyyy}-${mm}-${dd}`);
      if (allDates.length >= maxDays) break;
    }
    if (allDates.length === 0) return []; // range entirely outside the ledger window
    
    // Build a VALUES clause for all dates using bound parameters (one '?' per date).
    // Dates are internally generated, but parameterized for consistency and safety.
    const datesValues = allDates.map(() => 'SELECT ? as date').join(' UNION ALL ');

    // Build dynamic CASE statements for each category.
    // - The compared category_name is a bound VALUE parameter ('?').
    // - The output column ALIAS is a SQL identifier (cannot be a parameter), so it is
    //   safely double-quoted with any embedded double-quote escaped ("" per SQLite rules).
    const quoteIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"';
    const categoryCases = categoryNames.map(name =>
      `COALESCE(SUM(CASE WHEN t.category_name = ? THEN 1 ELSE 0 END), 0) as ${quoteIdent(name)}`
    ).join(', ');

    // Parameter order MUST match placeholder order in the SQL text below:
    // the category CASE '?' placeholders appear in the SELECT (before FROM),
    // followed by the date '?' placeholders in the FROM subquery.
    let query;
    let params;
    if (categoryNames.length > 0) {
      query = `
        SELECT 
          d.date,
          ${categoryCases},
          COALESCE(COUNT(t.id), 0) as total_tickets,
          COALESCE(SUM(t.price), 0) as revenue,
          COALESCE(e.total_expenses, 0) as expenses,
          COALESCE(ds.status, 'working') as day_status
        FROM (${datesValues}) d
        LEFT JOIN tickets t ON t.date = d.date AND t.refunded_at IS NULL
        LEFT JOIN (
          SELECT date, SUM(amount) as total_expenses 
          FROM expenses 
          GROUP BY date
        ) e ON d.date = e.date
        LEFT JOIN day_status ds ON d.date = ds.date
        GROUP BY d.date 
        ORDER BY d.date DESC
      `;
      params = [...categoryNames, ...allDates];
    } else {
      query = `
        SELECT 
          d.date,
          COALESCE(COUNT(t.id), 0) as total_tickets,
          COALESCE(SUM(t.price), 0) as revenue,
          COALESCE(e.total_expenses, 0) as expenses,
          COALESCE(ds.status, 'working') as day_status
        FROM (${datesValues}) d
        LEFT JOIN tickets t ON t.date = d.date AND t.refunded_at IS NULL
        LEFT JOIN (
          SELECT date, SUM(amount) as total_expenses 
          FROM expenses 
          GROUP BY date
        ) e ON d.date = e.date
        LEFT JOIN day_status ds ON d.date = ds.date
        GROUP BY d.date 
        ORDER BY d.date DESC
      `;
      params = [...allDates];
    }
    
    const result = this.db.exec(query, params);
    
    const summaries = [];
    if (result.length > 0 && result[0].values) {
      result[0].values.forEach(row => {
        const summary = {
          date: row[0]
        };
        
        // Add category counts dynamically
        categoryNames.forEach((name, index) => {
          summary[name] = row[index + 1] || 0;
        });
        
        // Add totals (they're at the end of the row)
        const baseIndex = categoryNames.length + 1;
        summary.total_tickets = row[baseIndex] || 0;
        summary.revenue = row[baseIndex + 1] || 0;
        summary.expenses = row[baseIndex + 2] || 0;
        summary.day_status = row[baseIndex + 3] || 'working';
        
        summaries.push(summary);
      });
    }
    
    return summaries;
  }

  /**
   * Day Status Management
   */
  setDayStatus(date, status) {
    // status: 'working' | 'holiday' | 'repair'
    this.db.run(
      `INSERT OR REPLACE INTO day_status (date, status) VALUES (?, ?)`,
      [date, status]
    );
    this.logAudit('UPDATE', 'day_status', null, `${date} → ${status}`);
    this.save();
    return true;
  }

  getDayStatus(date) {
    const result = this.db.exec(`SELECT status FROM day_status WHERE date = ?`, [date]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return 'working';
  }

  /**
   * Teller Change Float Management
   * Kept completely separate from sales revenue, expenses, and collections.
   * Never included in getCashInHand().
   */
  getFloatBalance() {
    const result = this.db.exec(`
      SELECT COALESCE(SUM(CASE WHEN operation = 'add' THEN amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN operation = 'take' THEN amount ELSE 0 END), 0) AS balance
      FROM change_float
    `);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] || 0;
    }
    return 0;
  }

  addFloat(amount, note = '') {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      return { success: false, error: 'المبلغ غير صالح' };
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const balanceAfter = this.getFloatBalance() + value;

    this.db.run(
      'INSERT INTO change_float (operation, amount, balance_after, note, date, time) VALUES (?, ?, ?, ?, ?, ?)',
      ['add', value, balanceAfter, note || '', date, time]
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];

    this.logAudit('CREATE', 'change_float', id, `add ${value}dh → balance ${balanceAfter}dh`);
    this.save();
    return { success: true, id, balance: balanceAfter, operation: 'add', amount: value, note: note || '', date, time };
  }

  takeFloat(amount, note = '') {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      return { success: false, error: 'المبلغ غير صالح' };
    }

    const currentBalance = this.getFloatBalance();
    if (value > currentBalance) {
      return { success: false, error: 'المبلغ المطلوب أكبر من الرصيد المتوفر' };
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const balanceAfter = currentBalance - value;

    this.db.run(
      'INSERT INTO change_float (operation, amount, balance_after, note, date, time) VALUES (?, ?, ?, ?, ?, ?)',
      ['take', value, balanceAfter, note || '', date, time]
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];

    this.logAudit('CREATE', 'change_float', id, `take ${value}dh → balance ${balanceAfter}dh`);
    this.save();
    return { success: true, id, balance: balanceAfter, operation: 'take', amount: value, note: note || '', date, time };
  }

  getFloatHistory() {
    const result = this.db.exec('SELECT * FROM change_float ORDER BY timestamp DESC, id DESC');
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Delete Operations (Admin Only)
   */
  deleteTicket(ticketId) {
    // Get ticket details for audit log before deletion
    const ticketResult = this.db.exec('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!ticketResult[0] || ticketResult[0].values.length === 0) {
      throw new Error('Ticket not found');
    }
    
    const cols = ticketResult[0].columns;
    const row = ticketResult[0].values[0];
    const ticket = {};
    cols.forEach((col, i) => ticket[col] = row[i]);
    
    // Delete the ticket
    this.db.run('DELETE FROM tickets WHERE id = ?', [ticketId]);
    
    // Log the deletion
    this.logAudit('DELETE', 'tickets', ticketId, `${ticket.category_name} - ${ticket.serial_number}/${ticket.year} - ${ticket.price}dh`);
    this.save();
    
    return ticket;
  }

  deleteExpense(expenseId) {
    // Get expense details for audit log before deletion
    const expenseResult = this.db.exec('SELECT * FROM expenses WHERE id = ?', [expenseId]);
    if (!expenseResult[0] || expenseResult[0].values.length === 0) {
      throw new Error('Expense not found');
    }
    
    const cols = expenseResult[0].columns;
    const row = expenseResult[0].values[0];
    const expense = {};
    cols.forEach((col, i) => expense[col] = row[i]);
    
    // Delete the expense
    this.db.run('DELETE FROM expenses WHERE id = ?', [expenseId]);
    
    // Log the deletion
    this.logAudit('DELETE', 'expenses', expenseId, `${expense.description} - ${expense.amount}dh`);
    this.save();
    
    return expense;
  }

  deleteCollection(collectionId) {
    // Get collection details for audit log before deletion
    const collectionResult = this.db.exec('SELECT * FROM collections WHERE id = ?', [collectionId]);
    if (!collectionResult[0] || collectionResult[0].values.length === 0) {
      throw new Error('Collection not found');
    }
    
    const cols = collectionResult[0].columns;
    const row = collectionResult[0].values[0];
    const collection = {};
    cols.forEach((col, i) => collection[col] = row[i]);
    
    // Delete the collection and its day associations (so those days become
    // available again). Guarded in case the table does not exist on older installs.
    this.db.run('DELETE FROM collections WHERE id = ?', [collectionId]);
    try { this.db.run('DELETE FROM collection_days WHERE collection_id = ?', [collectionId]); } catch (_) {}
    
    // Log the deletion
    this.logAudit('DELETE', 'collections', collectionId, `${collection.amount}dh - ${collection.notes || 'No notes'}`);
    this.save();
    
    return collection;
  }

  /**
   * Clear all transaction data (Admin only - for testing)
   * WARNING: This deletes all tickets, expenses, collections, and resets counters
   */
  clearAllData() {
    try {
      console.log('🗑️ Starting data clear operation...');
      
      // Get counts before deletion for logging
      const ticketsCount = this.db.exec('SELECT COUNT(*) FROM tickets')[0]?.values[0]?.[0] || 0;
      const expensesCount = this.db.exec('SELECT COUNT(*) FROM expenses')[0]?.values[0]?.[0] || 0;
      const collectionsCount = this.db.exec('SELECT COUNT(*) FROM collections')[0]?.values[0]?.[0] || 0;
      const floatCount = this.db.exec('SELECT COUNT(*) FROM change_float')[0]?.values[0]?.[0] || 0;
      
      // Delete all transaction data
      this.db.run('DELETE FROM tickets');
      this.db.run('DELETE FROM expenses');
      this.db.run('DELETE FROM collections');
      try { this.db.run('DELETE FROM collection_days'); } catch (_) {} // Table may not exist on older installs
      this.db.run('DELETE FROM daily_summary');
      this.db.run('DELETE FROM change_float'); // reset teller change float to 0
      try { this.db.run('DELETE FROM wood_purchases'); } catch (_) {} // Table may not exist on fresh installs
      try { this.db.run('DELETE FROM wood_sellers'); } catch (_) {} // Table may not exist on older installs
      try { this.db.run('DELETE FROM wood_seller_types'); } catch (_) {} // Table may not exist on older installs
      // Everything else that describes past activity (each guarded: tables differ between versions)
      ['day_status', 'zakat_days', 'zakat_tracking', 'serial_resets', 'sync_queue', 'sync_status', 'email_log']
        .forEach(t => { try { this.db.run('DELETE FROM ' + t); } catch (_) {} });
      
      // Reset category serial counters
      this.db.run('UPDATE categories SET serial_counter = 0');
      
      // Log the clear operation
      this.logAudit('CLEAR_ALL_DATA', 'system', null, 
        `Cleared: ${ticketsCount} tickets, ${expensesCount} expenses, ${collectionsCount} collections, ${floatCount} float operations`);
      
      this.save();
      
      console.log(`✅ Data cleared successfully:`);
      console.log(`   🎫 Tickets deleted: ${ticketsCount}`);
      console.log(`   💸 Expenses deleted: ${expensesCount}`);
      console.log(`   💰 Collections deleted: ${collectionsCount}`);
      console.log(`   🔄 Serial counters reset`);
      
      return {
        success: true,
        cleared: {
          tickets: ticketsCount,
          expenses: expensesCount,
          collections: collectionsCount
        }
      };
    } catch (error) {
      console.error('❌ Failed to clear data:', error);
      this.logAudit('CLEAR_ALL_DATA_ERROR', 'system', null, error.message);
      throw error;
    }
  }

  /**
   * Re-read the database FILE from disk and report any transaction rows that are still
   * there. Proves a wipe really reached the file, not only the in-memory copy.
   */
  verifyWipe() {
    const tables = ['tickets', 'expenses', 'collections', 'collection_days', 'change_float', 'wood_purchases',
      'day_status', 'zakat_days', 'money_expenses', 'expense_payments', 'money_collections', 'seller_debts',
      'seller_debt_payments', 'money_corrections', 'notifications', 'sync_queue'];
    try {
      const copy = new this.SQL.Database(fs.readFileSync(this.dbPath));
      const leftovers = {};
      for (const t of tables) {
        try {
          const n = copy.exec('SELECT COUNT(*) FROM ' + t)[0].values[0][0];
          if (n > 0) leftovers[t] = n;
        } catch (_) { /* table does not exist */ }
      }
      copy.close();
      return { persisted: true, clean: Object.keys(leftovers).length === 0, leftovers, dbPath: this.dbPath };
    } catch (error) {
      return { persisted: false, clean: false, error: error.message, dbPath: this.dbPath };
    }
  }

  /** Row counts of the main tables (for the diagnostics shown to the manager / dashboard). */
  getTableCounts() {
    const out = {};
    for (const t of ['tickets', 'expenses', 'collections', 'categories', 'money_expenses', 'money_collections']) {
      try { out[t] = this.db.exec('SELECT COUNT(*) FROM ' + t)[0].values[0][0]; } catch (_) { out[t] = null; }
    }
    return out;
  }

  /**
   * Utility Methods
   */
  logAudit(action, entity, entityId = null, details = null) {
    this.db.run('INSERT INTO audit_log (action, entity, entity_id, details) VALUES (?, ?, ?, ?)',
      [action, entity, entityId, details]);
  }

  close() {
    if (this.db) {
      this.db.close();
      console.log('✅ Database closed');
    }
  }
}

module.exports = StorageManager;