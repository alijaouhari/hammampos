/**
 * HammamPOS - ExpenseTemplateManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Predefined Expense Templates - Handles expense categories, templates, and wood calculations
 */

class ExpenseTemplateManager {
  constructor(storageManager) {
    this.storage = storageManager;
  }

  /**
   * Initialize expense templates table
   */
  initialize() {
    try {
      if (!this.storage || !this.storage.db) {
        throw new Error('Storage manager or database not available');
      }

      // Create expense templates table
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS expense_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        fixed_amount REAL DEFAULT NULL,
        unit TEXT DEFAULT NULL,
        price_per_unit REAL DEFAULT NULL,
        description TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);

      // Create wood purchases table.
      // NOTE: legacy per-kg columns (truck_weight_*, price_per_kg) are kept NULL-able
      // so per-load / agreement purchases do not have to fill them.
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS wood_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_name TEXT NOT NULL,
        truck_weight_gross REAL,
        truck_weight_empty REAL,
        net_wood_weight REAL,
        price_per_kg REAL,
        total_amount REAL NOT NULL,
        delivery_date TEXT NOT NULL,
        notes TEXT,
        expense_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (expense_id) REFERENCES expenses(id)
      )`);

      // Wood sellers (managed list). default_price_per_kg is a DEFAULT only — never
      // forced onto a purchase. Deactivation (active=0) hides a seller from new
      // purchases without deleting history.
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS wood_sellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        wood_type TEXT,
        default_price_per_kg REAL,
        active INTEGER DEFAULT 1,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);

      // Migrate wood_purchases with the new columns (idempotent; ADD COLUMN throws if
      // the column already exists, so each is guarded). Existing rows keep sensible
      // defaults: paid=1 (they already created an expense), pricing_method='per_kg'.
      const woodPurchaseMigrations = [
        "ALTER TABLE wood_purchases ADD COLUMN seller_id INTEGER",
        "ALTER TABLE wood_purchases ADD COLUMN wood_type TEXT",
        "ALTER TABLE wood_purchases ADD COLUMN pricing_method TEXT DEFAULT 'per_kg'",
        "ALTER TABLE wood_purchases ADD COLUMN unit_price REAL",
        "ALTER TABLE wood_purchases ADD COLUMN paid INTEGER DEFAULT 1",
        "ALTER TABLE wood_purchases ADD COLUMN paid_date TEXT"
      ];
      for (const sql of woodPurchaseMigrations) {
        try { this.storage.db.run(sql); } catch (_) { /* column already exists */ }
      }

      this.storage.db.run(`CREATE INDEX IF NOT EXISTS idx_wood_purchases_seller ON wood_purchases(seller_id)`);
      this.storage.db.run(`CREATE INDEX IF NOT EXISTS idx_wood_purchases_paid ON wood_purchases(paid)`);

      // A seller can supply MULTIPLE wood types. This join table holds the wood
      // types registered for each seller. The legacy wood_sellers.wood_type column
      // is kept for back-compat and treated as a single default/first type.
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS wood_seller_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id INTEGER NOT NULL,
        wood_type TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES wood_sellers(id)
      )`);
      this.storage.db.run(`CREATE INDEX IF NOT EXISTS idx_wood_seller_types_seller ON wood_seller_types(seller_id)`);

      // One-time backfill: existing sellers created before this table had a single
      // wood_type stored on wood_sellers. Copy it into the join table if the seller
      // has no rows there yet. Idempotent (guarded by the NOT EXISTS check).
      try {
        this.storage.db.run(`
          INSERT INTO wood_seller_types (seller_id, wood_type)
          SELECT s.id, s.wood_type
          FROM wood_sellers s
          WHERE s.wood_type IS NOT NULL AND TRIM(s.wood_type) <> ''
            AND NOT EXISTS (SELECT 1 FROM wood_seller_types t WHERE t.seller_id = s.id)
        `);
      } catch (_) { /* best-effort backfill */ }

      this.storage.save();
      
      // Create default templates if none exist
      this.createDefaultTemplates();
      
      console.log('✅ ExpenseTemplateManager initialized');
      return { success: true };

    } catch (error) {
      console.error('❌ ExpenseTemplateManager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Seed the default expense templates ONLY on a brand-new (empty) table.
   *
   * IMPORTANT: this must NOT delete existing rows. Owner-created expense types are
   * persistent data; wiping and re-seeding on every startup (the previous behavior)
   * would destroy them on the next launch. We therefore seed the built-in defaults
   * exactly once — when the table has no rows — and otherwise leave all existing
   * templates (defaults + owner-created) untouched.
   */
  createDefaultTemplates() {
    // Only seed when the table is completely empty (first run / fresh DB).
    const countResult = this.storage.db.exec('SELECT COUNT(*) FROM expense_templates');
    const existingCount = (countResult[0] && countResult[0].values[0][0]) || 0;
    if (existingCount > 0) {
      return; // Preserve existing templates (defaults and any owner-created types).
    }

    const requiredTemplates = [
      { name: 'فاتورة الماء والكهرباء', category: 'عام', fixed_amount: null, description: 'فاتورة الماء والكهرباء الشهرية' },
      { name: 'أجر صاحب الصندوق', category: 'عام', fixed_amount: null, description: 'أجر صاحب الصندوق' },
      { name: 'أجر الفرناتشي', category: 'عام', fixed_amount: null, description: 'أجر الفرناتشي' },
    ];

    for (const t of requiredTemplates) {
      this.storage.db.run(`
        INSERT INTO expense_templates (name, category, fixed_amount, unit, price_per_unit, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [t.name, t.category, t.fixed_amount, null, null, t.description]);
    }

    this.storage.save();
  }

  /**
   * Get all expense templates
   */
  getTemplates(activeOnly = true) {
    const sql = activeOnly 
      ? 'SELECT * FROM expense_templates WHERE active = 1 ORDER BY category, name'
      : 'SELECT * FROM expense_templates ORDER BY category, name';
    
    const result = this.storage.db.exec(sql);
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Get templates grouped by category
   */
  getTemplatesByCategory(activeOnly = true) {
    const templates = this.getTemplates(activeOnly);
    const grouped = {};
    
    templates.forEach(template => {
      if (!grouped[template.category]) {
        grouped[template.category] = [];
      }
      grouped[template.category].push(template);
    });
    
    return grouped;
  }

  /**
   * Add new expense template
   */
  addTemplate(name, category, fixedAmount = null, unit = null, pricePerUnit = null, description = '') {
    this.storage.db.run(`
      INSERT INTO expense_templates (name, category, fixed_amount, unit, price_per_unit, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, category, fixedAmount, unit, pricePerUnit, description]);
    
    const result = this.storage.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    
    this.storage.logAudit('CREATE', 'expense_templates', id, `${name} - ${category}`);
    this.storage.save();
    
    return id;
  }

  /**
   * Update expense template
   */
  updateTemplate(id, name, category, fixedAmount = null, unit = null, pricePerUnit = null, description = '') {
    this.storage.db.run(`
      UPDATE expense_templates 
      SET name = ?, category = ?, fixed_amount = ?, unit = ?, price_per_unit = ?, description = ?
      WHERE id = ?
    `, [name, category, fixedAmount, unit, pricePerUnit, description, id]);
    
    this.storage.logAudit('UPDATE', 'expense_templates', id, `${name} - ${category}`);
    this.storage.save();
    
    return true;
  }

  /**
   * Toggle template active status
   */
  toggleTemplate(id, active) {
    this.storage.db.run('UPDATE expense_templates SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    this.storage.logAudit('UPDATE', 'expense_templates', id, `active = ${active}`);
    this.storage.save();
    return true;
  }

  /**
   * Calculate wood expense
   */
  calculateWoodExpense(grossWeight, emptyWeight, pricePerKg) {
    const netWeight = grossWeight - emptyWeight;
    const totalAmount = netWeight * pricePerKg;
    
    return {
      netWeight,
      totalAmount
    };
  }

  /**
   * Add wood purchase record
   */
  addWoodPurchase(supplierName, grossWeight, emptyWeight, pricePerKg, deliveryDate, notes = '') {
    const calculation = this.calculateWoodExpense(grossWeight, emptyWeight, pricePerKg);
    
    // First create the expense record
    const expenseId = this.storage.addExpense(
      `خشب - ${supplierName} (${calculation.netWeight} كغ)`,
      calculation.totalAmount
    );
    
    // Then create the wood purchase record
    this.storage.db.run(`
      INSERT INTO wood_purchases 
      (supplier_name, truck_weight_gross, truck_weight_empty, net_wood_weight, price_per_kg, total_amount, delivery_date, notes, expense_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [supplierName, grossWeight, emptyWeight, calculation.netWeight, pricePerKg, calculation.totalAmount, deliveryDate, notes, expenseId]);
    
    const result = this.storage.db.exec('SELECT last_insert_rowid()');
    const woodId = result[0].values[0][0];
    
    this.storage.logAudit('CREATE', 'wood_purchases', woodId, 
      `${supplierName} - ${calculation.netWeight}kg - ${calculation.totalAmount}dh`);
    this.storage.save();
    
    return {
      woodId,
      expenseId,
      ...calculation
    };
  }

  /**
   * Get wood purchases history
   */
  getWoodPurchases(limit = 50) {
    // Coerce to a safe non-negative integer; bind as a parameter (no interpolation).
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 50;
    const result = this.storage.db.exec(`
      SELECT * FROM wood_purchases 
      ORDER BY delivery_date DESC, created_at DESC 
      LIMIT ?
    `, [safeLimit]);
    
    if (!result[0]) return [];
    
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  // ─── Wood sellers (managed list) ────────────────────────────────────

  /**
   * Create a wood seller. default_price_per_kg is optional (a DEFAULT only).
   * @returns {{success:boolean, id?:number, error?:string}}
   */
  addWoodSeller(name, phone = '', woodType = '', defaultPricePerKg = null, notes = '') {
    const cleanName = (name == null ? '' : String(name).trim());
    if (!cleanName) return { success: false, error: 'اسم البائع مطلوب' };
    let price = null;
    if (defaultPricePerKg !== null && defaultPricePerKg !== '' && defaultPricePerKg !== undefined) {
      const p = Number(defaultPricePerKg);
      if (!Number.isFinite(p) || p < 0) return { success: false, error: 'سعر الكيلو الافتراضي غير صالح' };
      price = p;
    }
    // woodType may be a single string (legacy) or an array of types (new).
    const types = this._normalizeWoodTypes(woodType);
    const primaryType = types[0] || '';
    this.storage.db.run(
      'INSERT INTO wood_sellers (name, phone, wood_type, default_price_per_kg, active, notes) VALUES (?, ?, ?, ?, 1, ?)',
      [cleanName, phone || '', primaryType, price, notes || '']
    );
    const id = this.storage.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    this._setWoodSellerTypes(id, types);
    this.storage.logAudit('CREATE', 'wood_sellers', id, `${cleanName} - ${types.join(', ')}`);
    this.storage.save();
    return { success: true, id };
  }

  /**
   * Normalize a wood-type argument (string, comma/newline-separated string, or
   * array) into a de-duplicated array of trimmed non-empty type names.
   */
  _normalizeWoodTypes(woodType) {
    let raw = [];
    if (Array.isArray(woodType)) {
      raw = woodType;
    } else if (woodType != null && String(woodType).trim() !== '') {
      // split on comma / Arabic comma / newline so a legacy single field still works
      raw = String(woodType).split(/[,،\n]/);
    }
    const seen = new Set();
    const out = [];
    for (const t of raw) {
      const clean = String(t).trim();
      if (clean && !seen.has(clean)) { seen.add(clean); out.push(clean); }
    }
    return out;
  }

  /**
   * Replace the registered wood types for a seller with the given list.
   * Historical wood_purchases snapshot their own wood_type, so editing a
   * seller's types never rewrites past purchases.
   */
  _setWoodSellerTypes(sellerId, types) {
    try { this.storage.db.run('DELETE FROM wood_seller_types WHERE seller_id = ?', [sellerId]); } catch (_) {}
    for (const t of types) {
      this.storage.db.run('INSERT INTO wood_seller_types (seller_id, wood_type) VALUES (?, ?)', [sellerId, t]);
    }
  }

  /**
   * Wood types registered for a seller (array of strings). Falls back to the
   * legacy wood_sellers.wood_type column if the join table has no rows.
   */
  getWoodSellerTypes(sellerId) {
    const result = this.storage.db.exec(
      'SELECT wood_type FROM wood_seller_types WHERE seller_id = ? ORDER BY id', [sellerId]
    );
    if (result[0] && result[0].values.length) {
      return result[0].values.map(r => r[0]);
    }
    const seller = this.storage.db.exec('SELECT wood_type FROM wood_sellers WHERE id = ?', [sellerId]);
    if (seller[0] && seller[0].values.length) {
      const t = seller[0].values[0][0];
      if (t && String(t).trim() !== '') return [String(t).trim()];
    }
    return [];
  }

  /**
   * List wood sellers. activeOnly=true returns only enabled sellers (for the picker).
   */
  getWoodSellers(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM wood_sellers WHERE active = 1 ORDER BY name'
      : 'SELECT * FROM wood_sellers ORDER BY name';
    const result = this.storage.db.exec(sql);
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      obj.types = this.getWoodSellerTypes(obj.id); // multiple wood types per seller
      return obj;
    });
  }

  getWoodSeller(id) {
    const result = this.storage.db.exec('SELECT * FROM wood_sellers WHERE id = ?', [id]);
    if (!result[0] || result[0].values.length === 0) return null;
    const cols = result[0].columns;
    const obj = {};
    cols.forEach((col, i) => obj[col] = result[0].values[0][i]);
    obj.types = this.getWoodSellerTypes(id);
    return obj;
  }

  /**
   * Update a seller's current configuration. Does NOT affect historical purchases
   * (those store their own snapshot of seller name / wood type / price).
   */
  updateWoodSeller(id, name, phone = '', woodType = '', defaultPricePerKg = null, notes = '') {
    const cleanName = (name == null ? '' : String(name).trim());
    if (!cleanName) return { success: false, error: 'اسم البائع مطلوب' };
    let price = null;
    if (defaultPricePerKg !== null && defaultPricePerKg !== '' && defaultPricePerKg !== undefined) {
      const p = Number(defaultPricePerKg);
      if (!Number.isFinite(p) || p < 0) return { success: false, error: 'سعر الكيلو الافتراضي غير صالح' };
      price = p;
    }
    const types = this._normalizeWoodTypes(woodType);
    const primaryType = types[0] || '';
    this.storage.db.run(
      'UPDATE wood_sellers SET name = ?, phone = ?, wood_type = ?, default_price_per_kg = ?, notes = ? WHERE id = ?',
      [cleanName, phone || '', primaryType, price, notes || '', id]
    );
    this._setWoodSellerTypes(id, types);
    this.storage.logAudit('UPDATE', 'wood_sellers', id, `${cleanName} - ${types.join(', ')}`);
    this.storage.save();
    return { success: true };
  }

  toggleWoodSeller(id, active) {
    this.storage.db.run('UPDATE wood_sellers SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    this.storage.logAudit('UPDATE', 'wood_sellers', id, `active = ${active}`);
    this.storage.save();
    return { success: true };
  }

  /**
   * Permanently remove a seller and its registered wood types.
   *
   * Historical wood_purchases are DELIBERATELY left untouched: each purchase row
   * snapshots supplier_name / wood_type / unit_price, so past purchases remain
   * fully readable and financially accurate even after the seller is deleted.
   * (This is distinct from toggleWoodSeller, which only hides an active seller.)
   *
   * @returns {{success:boolean, error?:string}}
   */
  deleteWoodSeller(id) {
    const seller = this.getWoodSeller(id);
    if (!seller) return { success: false, error: 'المورد غير موجود' };
    // Remove the seller's registered types, then the seller record. Never touch
    // wood_purchases — those keep their own snapshot for historical integrity.
    try { this.storage.db.run('DELETE FROM wood_seller_types WHERE seller_id = ?', [id]); } catch (_) {}
    this.storage.db.run('DELETE FROM wood_sellers WHERE id = ?', [id]);
    this.storage.logAudit('DELETE', 'wood_sellers', id, `${seller.name} (permanent)`);
    this.storage.save();
    return { success: true };
  }

  // ─── Wood purchases (per-kg / per-load / agreement, paid or unpaid) ──

  /**
   * Record a wood purchase from a managed seller.
   *
   * pricingMethod:
   *   'per_kg'      -> requires netWeight (>0) and unitPrice (>=0); total = netWeight*unitPrice
   *   'per_load'    -> requires totalAmount (>0); records total weight (netWeight) too;
   *                    the price is the agreed load price and is NOT computed from a
   *                    per-kg default.
   *   'agreement'   -> requires totalAmount (>0); optional weight; no per-kg calc.
   *
   * Payment model (wood-specific; does NOT change getCashInHand):
   *   - If paid === true: an expenses row is created NOW (cash-in-hand drops now),
   *     paid_date = deliveryDate, expense_id stored.
   *   - If paid === false: NO expenses row is created; the purchase is OUTSTANDING
   *     (paid=0, expense_id NULL). Cash is unaffected until payWoodPurchase() is called.
   *
   * Snapshots seller name + wood type + unit price on the row for historical integrity.
   *
   * @returns {{success:boolean, woodId?:number, expenseId?:number|null, totalAmount?:number, error?:string}}
   */
  recordWoodPurchase(opts) {
    const {
      sellerId = null,
      woodType = '',
      pricingMethod,
      netWeight = null,
      unitPrice = null,
      totalAmount = null,
      deliveryDate,
      paid = true,
      notes = ''
    } = opts || {};

    if (!['per_kg', 'per_load', 'agreement'].includes(pricingMethod)) {
      return { success: false, error: 'طريقة تسعير غير صالحة' };
    }
    if (!deliveryDate) {
      return { success: false, error: 'تاريخ التسليم مطلوب' };
    }

    // Resolve seller snapshot (name + wood type). Seller is optional to remain tolerant,
    // but the UI always supplies one.
    let sellerName = '';
    let resolvedWoodType = woodType || '';
    if (sellerId != null) {
      const seller = this.getWoodSeller(sellerId);
      if (seller) {
        sellerName = seller.name;
        if (!resolvedWoodType) resolvedWoodType = seller.wood_type || '';
      }
    }
    if (!sellerName) sellerName = 'مورد';

    let net = null;
    let unit = null;
    let total = null;

    if (pricingMethod === 'per_kg') {
      net = Number(netWeight);
      unit = Number(unitPrice);
      if (!Number.isFinite(net) || net <= 0) return { success: false, error: 'الوزن الصافي غير صالح' };
      if (!Number.isFinite(unit) || unit < 0) return { success: false, error: 'سعر الكيلو غير صالح' };
      total = net * unit;
    } else {
      // per_load / agreement: the price is the agreed amount (NOT derived from a
      // per-kg default). A total weight may also be recorded (required for per_load).
      total = Number(totalAmount);
      if (!Number.isFinite(total) || total <= 0) return { success: false, error: 'المبلغ غير صالح' };
      if (netWeight != null && netWeight !== '' && Number.isFinite(Number(netWeight)) && Number(netWeight) > 0) {
        net = Number(netWeight);
      }
    }

    const isPaid = paid === true || paid === 1 || paid === '1';

    // Create the expense ONLY when paid now (cash impact at payment time).
    let expenseId = null;
    if (isPaid) {
      const label = `خشب - ${sellerName}${resolvedWoodType ? ' (' + resolvedWoodType + ')' : ''}`;
      expenseId = this.storage.addExpense(label, total);
    }

    // IMPORTANT: on databases created by older versions, wood_purchases.truck_weight_gross
    // and truck_weight_empty were declared NOT NULL. The per-load / per-kg-by-net flow
    // does not use the truck-weighing fields, so we must still supply non-null values
    // (0) for them or the INSERT fails with a NOT NULL constraint error — which is the
    // real cause of "تسجيل شراء الخشب does nothing" on existing installs. We write the
    // legacy weighing columns with safe defaults; the authoritative weight lives in
    // net_wood_weight.
    // Legacy databases declared truck_weight_gross, truck_weight_empty,
    // net_wood_weight and price_per_kg as NOT NULL. The per-load / agreement flow
    // (and unpaid per-kg) legitimately has no value for some of these, so we must
    // substitute safe non-null defaults or the INSERT fails with a NOT NULL
    // constraint — the real cause of "تسجيل شراء الخشب does nothing" on existing
    // installs. The authoritative numbers are net_wood_weight (weight) and
    // unit_price (per-kg rate); the legacy columns get 0 when not applicable.
    const truckGross = 0;
    const truckEmpty = 0;
    const netCol = (net == null ? 0 : net);
    const pricePerKgCol = (pricingMethod === 'per_kg' && unit != null) ? unit : 0;
    this.storage.db.run(`
      INSERT INTO wood_purchases
      (supplier_name, seller_id, wood_type, pricing_method, truck_weight_gross, truck_weight_empty, net_wood_weight, price_per_kg, unit_price, total_amount, delivery_date, notes, expense_id, paid, paid_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      sellerName, sellerId, resolvedWoodType, pricingMethod,
      truckGross, truckEmpty,
      netCol, pricePerKgCol, unit,
      total, deliveryDate, notes || '', expenseId,
      isPaid ? 1 : 0, isPaid ? deliveryDate : null
    ]);
    const woodId = this.storage.db.exec('SELECT last_insert_rowid()')[0].values[0][0];

    this.storage.logAudit('CREATE', 'wood_purchases', woodId,
      `${sellerName} - ${pricingMethod} - ${total}dh - ${isPaid ? 'paid' : 'unpaid'}`);
    this.storage.save();

    return { success: true, woodId, expenseId, totalAmount: total };
  }

  /**
   * Pay an outstanding wood purchase. Creates the linked expense NOW (cash-in-hand
   * drops now), sets paid=1 and paid_date. No-op-safe if already paid.
   * @returns {{success:boolean, expenseId?:number, error?:string}}
   */
  payWoodPurchase(woodId, paidDate = null) {
    const result = this.storage.db.exec('SELECT * FROM wood_purchases WHERE id = ?', [woodId]);
    if (!result[0] || result[0].values.length === 0) {
      return { success: false, error: 'سجل الخشب غير موجود' };
    }
    const cols = result[0].columns;
    const wp = {};
    cols.forEach((col, i) => wp[col] = result[0].values[0][i]);

    if (Number(wp.paid) === 1) {
      return { success: false, error: 'تم دفع هذا الشراء مسبقاً' };
    }

    const payDate = paidDate || new Date().toISOString().split('T')[0];
    const label = `خشب - ${wp.supplier_name}${wp.wood_type ? ' (' + wp.wood_type + ')' : ''}`;
    const expenseId = this.storage.addExpense(label, wp.total_amount);

    this.storage.db.run(
      'UPDATE wood_purchases SET paid = 1, paid_date = ?, expense_id = ? WHERE id = ?',
      [payDate, expenseId, woodId]
    );
    this.storage.logAudit('UPDATE', 'wood_purchases', woodId,
      `paid ${wp.total_amount}dh on ${payDate}`);
    this.storage.save();

    return { success: true, expenseId };
  }

  /**
   * Outstanding (unpaid) wood purchases, newest first.
   */
  getOutstandingWoodPurchases() {
    const result = this.storage.db.exec(
      'SELECT * FROM wood_purchases WHERE paid = 0 ORDER BY delivery_date DESC, created_at DESC'
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
   * Report: total wood amount and net weight received per seller.
   */
  getWoodBySeller() {
    const result = this.storage.db.exec(`
      SELECT supplier_name,
             COUNT(*) as purchases,
             COALESCE(SUM(total_amount), 0) as total_amount,
             COALESCE(SUM(COALESCE(net_wood_weight, 0)), 0) as total_weight,
             COALESCE(SUM(CASE WHEN paid = 0 THEN total_amount ELSE 0 END), 0) as outstanding_amount
      FROM wood_purchases
      GROUP BY supplier_name
      ORDER BY total_amount DESC
    `);
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Report: total wood amount and net weight received per wood type.
   */
  getWoodByType() {
    const result = this.storage.db.exec(`
      SELECT COALESCE(NULLIF(wood_type, ''), 'غير محدد') as wood_type,
             COUNT(*) as purchases,
             COALESCE(SUM(total_amount), 0) as total_amount,
             COALESCE(SUM(COALESCE(net_wood_weight, 0)), 0) as total_weight
      FROM wood_purchases
      GROUP BY COALESCE(NULLIF(wood_type, ''), 'غير محدد')
      ORDER BY total_amount DESC
    `);
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Resolve a template into its computed { amount, description } WITHOUT creating an
   * expense row. This is the single source of truth for template pricing/description
   * rules, so the unified expense-entry form can compute the values and then route
   * them through the shared StorageManager.recordExpense (which owns expense day /
   * paid / paid_date / payment_source). No expense is inserted here.
   *   pricingKind: 'fixed' (template.fixed_amount) | 'per_unit' (template.price_per_unit)
   *                | 'variable' (amount must be supplied by the caller)
   * @returns {{success:boolean, amount?:number, description?:string, pricingKind?:string, error?:string}}
   */
  getTemplateAmountAndDescription(templateId, quantity = 1, customAmount = null, notes = '') {
    const templateResult = this.storage.db.exec('SELECT * FROM expense_templates WHERE id = ?', [templateId]);
    if (!templateResult[0] || templateResult[0].values.length === 0) {
      return { success: false, error: 'Template not found' };
    }
    const cols = templateResult[0].columns;
    const row = templateResult[0].values[0];
    const template = {};
    cols.forEach((col, i) => template[col] = row[i]);

    const qty = Number(quantity) > 0 ? Number(quantity) : 1;
    let amount;
    let pricingKind;
    if (customAmount !== null && customAmount !== undefined && customAmount !== '') {
      amount = Number(customAmount);
      // A variable template supplies its amount via customAmount; a fixed/per-unit
      // template can still be overridden by an explicit customAmount.
      pricingKind = template.fixed_amount ? 'fixed' : (template.price_per_unit ? 'per_unit' : 'variable');
    } else if (template.fixed_amount) {
      amount = template.fixed_amount * qty;
      pricingKind = 'fixed';
    } else if (template.price_per_unit) {
      amount = template.price_per_unit * qty;
      pricingKind = 'per_unit';
    } else {
      // Variable template with no amount provided.
      return { success: false, error: 'Template has no pricing information', pricingKind: 'variable' };
    }

    let description = template.name;
    if (qty > 1 && template.unit) {
      description += ` (${qty} ${template.unit})`;
    }
    if (notes) {
      description += ` - ${notes}`;
    }

    return { success: true, amount, description, pricingKind };
  }

  /**
   * Create expense from template (LEGACY path — retained for backward compatibility
   * and existing tests). Uses the shared pricing/description resolver above, then the
   * default paid-business-cash-today insert via storage.addExpense. The unified UI
   * uses getTemplateAmountAndDescription + storage.recordExpense instead so it can
   * carry expense day / paid state / payment source.
   */
  createExpenseFromTemplate(templateId, quantity = 1, customAmount = null, notes = '') {
    const resolved = this.getTemplateAmountAndDescription(templateId, quantity, customAmount, notes);
    if (!resolved.success) {
      throw new Error(resolved.error || 'Template not found');
    }

    const expenseId = this.storage.addExpense(resolved.description, resolved.amount);

    this.storage.logAudit('CREATE', 'expenses', expenseId,
      `From template: ${resolved.description} - ${resolved.amount}dh`);

    return expenseId;
  }
}

module.exports = ExpenseTemplateManager;