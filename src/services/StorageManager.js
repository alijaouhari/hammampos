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

class StorageManager {
  constructor(dbPath = null) {
    // Store database in user's AppData so it survives app updates
    const appDataDir = path.join(process.env.APPDATA || process.env.HOME, 'HammamPOS');
    this.dbPath = dbPath || path.join(appDataDir, 'hammampos.db');
    
    // Migrate from old location if needed
    if (!fs.existsSync(this.dbPath)) {
      const oldPath = path.join(process.cwd(), 'data', 'hammampos.db');
      if (fs.existsSync(oldPath)) {
        if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
        fs.copyFileSync(oldPath, this.dbPath);
        console.log('📦 Database migrated to AppData');
      }
    }
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

  save() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (error) {
      console.error('❌ Save failed:', error);
    }
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

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_date ON tickets(date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_year ON tickets(year)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
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
      const countResult = this.db.exec('SELECT COUNT(*) as count FROM tickets WHERE category_id = ? AND date = ?', [obj.id, today]);
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
    return this.getTickets(today);
  }

  getTicketsForDate(date) {
    const result = this.db.exec(`
      SELECT id, serial_number, year, category_name, price, time, timestamp
      FROM tickets 
      WHERE date = ? 
      ORDER BY time ASC
    `, [date]);
    
    const tickets = [];
    if (result.length > 0) {
      result[0].values.forEach(row => {
        const [id, serial, year, category, price, time, timestamp] = row;
        tickets.push({
          id,
          serial_number: serial,
          year,
          category_name: category,
          price,
          time,
          timestamp
        });
      });
    }
    
    return tickets;
  }

  /**
   * Expenses Management
   */
  addExpense(description, amount) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];

    this.db.run('INSERT INTO expenses (description, amount, date, time) VALUES (?, ?, ?, ?)', 
      [description, amount, date, time]);
    
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    
    this.logAudit('CREATE', 'expenses', id, `${description} - ${amount}dh`);
    this.save();
    return id;
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
      SELECT id, description, amount, time, timestamp
      FROM expenses 
      WHERE date = ? 
      ORDER BY time ASC
    `, [date]);
    
    const expenses = [];
    if (result.length > 0) {
      result[0].values.forEach(row => {
        const [id, description, amount, time, timestamp] = row;
        expenses.push({
          id,
          description,
          amount,
          time,
          timestamp
        });
      });
    }
    
    return expenses;
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
   * @param {number} amount
   * @param {string} notes
   * @param {string[]} days - array of 'YYYY-MM-DD' dates included in this collection
   * @returns {{id:number, amount:number, notes:string, date:string, time:string, days:string[]}}
   */
  collectMoneyForDays(amount, notes = '', days = []) {
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
        this.db.run('INSERT INTO collection_days (collection_id, date) VALUES (?, ?)', [id, d]);
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

  /**
   * Financial Calculations
   */
  getCashInHand() {
    // Calculate total revenue from all tickets
    const revenueResult = this.db.exec('SELECT COALESCE(SUM(price), 0) as total FROM tickets');
    const totalRevenue = revenueResult[0] ? revenueResult[0].values[0][0] : 0;

    // Calculate total expenses
    const expensesResult = this.db.exec('SELECT COALESCE(SUM(amount), 0) as total FROM expenses');
    const totalExpenses = expensesResult[0] ? expensesResult[0].values[0][0] : 0;

    // Calculate total collections (money taken out)
    const collectionsResult = this.db.exec('SELECT COALESCE(SUM(amount), 0) as total FROM collections');
    const totalCollections = collectionsResult[0] ? collectionsResult[0].values[0][0] : 0;

    // Cash in hand = Revenue - Expenses - Collections
    return totalRevenue - totalExpenses - totalCollections;
  }

  getLifetimeRevenue() {
    const result = this.db.exec('SELECT COALESCE(SUM(price), 0) as total FROM tickets');
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
  getDailySummariesWithDetails(limit = 30) {
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
    
    // Generate all calendar dates from earliestDate to today
    const allDates = [];
    const startDate = new Date(earliestDate + 'T12:00:00');
    const endDate = new Date(today + 'T12:00:00');
    for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      allDates.push(`${yyyy}-${mm}-${dd}`);
      if (allDates.length >= limit) break;
    }
    
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
        LEFT JOIN tickets t ON t.date = d.date
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
        LEFT JOIN tickets t ON t.date = d.date
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