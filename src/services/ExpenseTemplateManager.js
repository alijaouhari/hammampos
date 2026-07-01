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

      // Create wood purchases table
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS wood_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_name TEXT NOT NULL,
        truck_weight_gross REAL NOT NULL,
        truck_weight_empty REAL NOT NULL,
        net_wood_weight REAL NOT NULL,
        price_per_kg REAL NOT NULL,
        total_amount REAL NOT NULL,
        delivery_date TEXT NOT NULL,
        notes TEXT,
        expense_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (expense_id) REFERENCES expenses(id)
      )`);

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
   * Create/migrate default expense templates.
   * Removes all old default templates and ensures only the required 3 exist.
   * Preserves any user-created templates (identified as those not in the known defaults list).
   * Idempotent — safe to run multiple times.
   */
  createDefaultTemplates() {
    // The ONLY templates that should exist as defaults
    const requiredTemplates = [
      { name: 'فاتورة الماء والكهرباء', category: 'فواتير', fixed_amount: null, description: 'فاتورة الماء والكهرباء الشهرية' },
      { name: 'أجر صاحب الصندوق', category: 'أجور', fixed_amount: null, description: 'أجر صاحب الصندوق' },
      { name: 'أجر الفرناتشي', category: 'أجور', fixed_amount: null, description: 'أجر الفرناتشي' },
    ];

    // All known old default template names to remove
    const oldDefaults = [
      'راتب موظف', 'راتب مدير', 'فاتورة كهرباء', 'فاتورة ماء',
      'فواتير (ماء وكهرباء)', 'إنترنت', 'إيجار', 'غاز', 'فحم',
      'صابون', 'شامبو', 'مناشف', 'صيانة عامة', 'تنظيف عميق',
      'مصروف متنوع'
    ];

    // Delete all old defaults
    for (const name of oldDefaults) {
      this.storage.db.run(`DELETE FROM expense_templates WHERE name = ?`, [name]);
    }

    // Insert required templates if they don't already exist
    for (const t of requiredTemplates) {
      const existing = this.storage.db.exec(`SELECT id FROM expense_templates WHERE name = '${t.name.replace(/'/g, "''")}'`);
      if (existing.length === 0 || existing[0].values.length === 0) {
        this.storage.db.run(`
          INSERT INTO expense_templates (name, category, fixed_amount, unit, price_per_unit, description)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [t.name, t.category, t.fixed_amount || null, null, null, t.description || '']);
      }
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
    const result = this.storage.db.exec(`
      SELECT * FROM wood_purchases 
      ORDER BY delivery_date DESC, created_at DESC 
      LIMIT ${limit}
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
   * Create expense from template
   */
  createExpenseFromTemplate(templateId, quantity = 1, customAmount = null, notes = '') {
    // Get template
    const templateResult = this.storage.db.exec(`SELECT * FROM expense_templates WHERE id = ${templateId}`);
    if (!templateResult[0] || templateResult[0].values.length === 0) {
      throw new Error('Template not found');
    }
    
    const cols = templateResult[0].columns;
    const row = templateResult[0].values[0];
    const template = {};
    cols.forEach((col, i) => template[col] = row[i]);
    
    // Calculate amount
    let amount;
    if (customAmount !== null) {
      amount = customAmount;
    } else if (template.fixed_amount) {
      amount = template.fixed_amount * quantity;
    } else if (template.price_per_unit) {
      amount = template.price_per_unit * quantity;
    } else {
      throw new Error('Template has no pricing information');
    }
    
    // Create description
    let description = template.name;
    if (quantity > 1 && template.unit) {
      description += ` (${quantity} ${template.unit})`;
    }
    if (notes) {
      description += ` - ${notes}`;
    }
    
    // Create expense
    const expenseId = this.storage.addExpense(description, amount);
    
    this.storage.logAudit('CREATE', 'expenses', expenseId, 
      `From template: ${template.name} - ${amount}dh`);
    
    return expenseId;
  }
}

module.exports = ExpenseTemplateManager;