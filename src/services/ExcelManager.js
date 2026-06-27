/**
 * HammamPOS - ExcelManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Excel File Integration - Handles real-time Excel backup and remote access
 * Works alongside BackupManager for dual backup strategy
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

class ExcelManager {
  constructor(excelPath = null) {
    const appDataDir = path.join(process.env.APPDATA || process.env.HOME, 'HammamPOS');
    this.excelPath = excelPath || path.join(appDataDir, 'hammampos.xlsx');
    this.workbook = null;
    this.isInitialized = false;
  }

  /**
   * Initialize Excel workbook and create sheets
   */
  async initialize() {
    try {
      console.log('📊 Initializing Excel Manager...');
      
      // Create workbook
      this.workbook = new ExcelJS.Workbook();
      
      // Set workbook properties
      this.workbook.creator = 'HammamPOS';
      this.workbook.lastModifiedBy = 'HammamPOS';
      this.workbook.created = new Date();
      this.workbook.modified = new Date();
      
      // Create sheets - exact mirror of database tables
      await this.createSettingsSheet();
      await this.createCategoriesSheet();
      await this.createTicketsSheet();
      await this.createExpensesSheet();
      await this.createCollectionsSheet();
      await this.createDailySummarySheet();
      await this.createAuditLogSheet();
      await this.createSerialResetsSheet();
      await this.createEmailLogSheet();
      await this.createSyncStatusSheet();
      
      // Save initial file
      await this.save();
      
      this.isInitialized = true;
      console.log('✅ Excel Manager initialized successfully');
      console.log(`📁 Excel file: ${this.excelPath}`);
      
      return { success: true };
    } catch (error) {
      console.error('❌ Excel Manager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Create Settings sheet - exact mirror of settings table
   */
  async createSettingsSheet() {
    const sheet = this.workbook.addWorksheet('الإعدادات', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns
    const headers = ['المفتاح', 'القيمة', 'تاريخ التحديث'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '6366f1' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 20 }, // key
      { width: 25 }, // value
      { width: 18 }  // updated_at
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Categories sheet - exact mirror of categories table
   */
  async createCategoriesSheet() {
    const sheet = this.workbook.addWorksheet('الفئات', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns
    const headers = ['المعرف', 'الاسم', 'السعر', 'نشط', 'عداد التسلسل', 'تاريخ الإنشاء'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '8b5cf6' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 15 }, // name
      { width: 10 }, // price
      { width: 8 },  // active
      { width: 12 }, // serial_counter
      { width: 18 }  // created_at
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  /**
   * Create Tickets sheet - exact mirror of tickets table
   */
  async createTicketsSheet() {
    const sheet = this.workbook.addWorksheet('التذاكر', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'الرقم التسلسلي', 'السنة', 'معرف الفئة', 'اسم الفئة', 'السعر', 'التاريخ', 'الوقت', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2563eb' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 12 }, // serial_number
      { width: 8 },  // year
      { width: 10 }, // category_id
      { width: 15 }, // category_name
      { width: 10 }, // price
      { width: 12 }, // date
      { width: 10 }, // time
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Expenses sheet - exact mirror of expenses table
   */
  async createExpensesSheet() {
    const sheet = this.workbook.addWorksheet('المصروفات', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'الوصف', 'المبلغ', 'التاريخ', 'الوقت', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'dc2626' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 25 }, // description
      { width: 12 }, // amount
      { width: 12 }, // date
      { width: 10 }, // time
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Collections sheet - exact mirror of collections table
   */
  async createCollectionsSheet() {
    const sheet = this.workbook.addWorksheet('عمليات التحصيل', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'المبلغ', 'التاريخ', 'الوقت', 'الملاحظات', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '059669' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 12 }, // amount
      { width: 12 }, // date
      { width: 10 }, // time
      { width: 25 }, // notes
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Daily Summary sheet - exact mirror of daily_summary table
   */
  async createDailySummarySheet() {
    const sheet = this.workbook.addWorksheet('الملخص اليومي', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'التاريخ', 'إجمالي التذاكر', 'إجمالي الإيرادات', 'إجمالي المصروفات', 'صافي الإيرادات', 'النقد في اليد', 'تفصيل الفئات', 'تاريخ الإنشاء'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7c3aed' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 12 }, // date
      { width: 12 }, // total_tickets
      { width: 15 }, // total_revenue
      { width: 15 }, // total_expenses
      { width: 15 }, // net_revenue
      { width: 15 }, // cash_in_hand
      { width: 30 }, // category_breakdown
      { width: 18 }  // created_at
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Audit Log sheet - exact mirror of audit_log table
   */
  async createAuditLogSheet() {
    const sheet = this.workbook.addWorksheet('سجل المراجعة', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'الإجراء', 'الكيان', 'معرف الكيان', 'التفاصيل', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'f59e0b' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 15 }, // action
      { width: 15 }, // entity
      { width: 12 }, // entity_id
      { width: 30 }, // details
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Serial Resets sheet - exact mirror of serial_resets table
   */
  async createSerialResetsSheet() {
    const sheet = this.workbook.addWorksheet('إعادة تعيين التسلسل', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'السنة', 'تاريخ الإعادة', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '10b981' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 10 }, // year
      { width: 15 }, // reset_date
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Email Log sheet - exact mirror of email_log table
   */
  async createEmailLogSheet() {
    const sheet = this.workbook.addWorksheet('سجل البريد الإلكتروني', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'المستقبل', 'الموضوع', 'الحالة', 'الخطأ', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'ef4444' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 25 }, // recipient
      { width: 30 }, // subject
      { width: 12 }, // status
      { width: 30 }, // error
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create Sync Status sheet - exact mirror of sync_status table
   */
  async createSyncStatusSheet() {
    const sheet = this.workbook.addWorksheet('حالة المزامنة', {
      properties: { rightToLeft: true }
    });
    
    // Headers matching database columns exactly
    const headers = ['المعرف', 'نوع المزامنة', 'الحالة', 'آخر مزامنة', 'الخطأ', 'الطابع الزمني'];
    sheet.addRow(headers);
    
    // Style headers
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '3b82f6' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Set column widths
    sheet.columns = [
      { width: 8 },  // id
      { width: 15 }, // sync_type
      { width: 12 }, // status
      { width: 18 }, // last_sync
      { width: 30 }, // error
      { width: 20 }  // timestamp
    ];
    
    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Add ticket to Excel - exact database mirror
   */
  async addTicket(ticket) {
    if (!this.isInitialized) {
      console.warn('⚠️ Excel Manager not initialized, skipping ticket add');
      return;
    }

    try {
      const sheet = this.workbook.getWorksheet('التذاكر');
      
      const row = [
        ticket.id,
        ticket.serial_number,
        ticket.year,
        ticket.category_id,
        ticket.category_name,
        ticket.price,
        ticket.date,
        ticket.time,
        ticket.timestamp
      ];
      
      sheet.addRow(row);
      await this.save();
      
      console.log('📊 Ticket added to Excel');
    } catch (error) {
      console.error('❌ Failed to add ticket to Excel:', error);
    }
  }

  /**
   * Add expense to Excel - exact database mirror
   */
  async addExpense(expense) {
    if (!this.isInitialized) {
      console.warn('⚠️ Excel Manager not initialized, skipping expense add');
      return;
    }

    try {
      const sheet = this.workbook.getWorksheet('المصروفات');
      
      const row = [
        expense.id,
        expense.description,
        expense.amount,
        expense.date,
        expense.time,
        expense.timestamp
      ];
      
      sheet.addRow(row);
      await this.save();
      
      console.log('📊 Expense added to Excel');
    } catch (error) {
      console.error('❌ Failed to add expense to Excel:', error);
    }
  }

  /**
   * Add collection to Excel - exact database mirror
   */
  async addCollection(collection) {
    if (!this.isInitialized) {
      console.warn('⚠️ Excel Manager not initialized, skipping collection add');
      return;
    }

    try {
      const sheet = this.workbook.getWorksheet('عمليات التحصيل');
      
      const row = [
        collection.id,
        collection.amount,
        collection.date,
        collection.time,
        collection.notes || '',
        collection.timestamp
      ];
      
      sheet.addRow(row);
      await this.save();
      
      console.log('📊 Collection added to Excel');
    } catch (error) {
      console.error('❌ Failed to add collection to Excel:', error);
    }
  }

  /**
   * Add setting to Excel
   */
  async addSetting(setting) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('الإعدادات');
      const row = [setting.key, setting.value, setting.updated_at];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add setting to Excel:', error);
    }
  }

  /**
   * Add category to Excel
   */
  async addCategory(category) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('الفئات');
      const row = [
        category.id,
        category.name,
        category.price,
        category.active,
        category.serial_counter,
        category.created_at
      ];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add category to Excel:', error);
    }
  }

  /**
   * Add daily summary to Excel
   */
  async addDailySummary(summary) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('الملخص اليومي');
      const row = [
        summary.id,
        summary.date,
        summary.total_tickets,
        summary.total_revenue,
        summary.total_expenses,
        summary.net_revenue,
        summary.cash_in_hand,
        summary.category_breakdown,
        summary.created_at
      ];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add daily summary to Excel:', error);
    }
  }

  /**
   * Add audit log entry to Excel
   */
  async addAuditLog(audit) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('سجل المراجعة');
      const row = [
        audit.id,
        audit.action,
        audit.entity,
        audit.entity_id,
        audit.details,
        audit.timestamp
      ];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add audit log to Excel:', error);
    }
  }

  /**
   * Add serial reset to Excel
   */
  async addSerialReset(reset) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('إعادة تعيين التسلسل');
      const row = [reset.id, reset.year, reset.reset_date, reset.timestamp];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add serial reset to Excel:', error);
    }
  }

  /**
   * Add email log to Excel
   */
  async addEmailLog(email) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('سجل البريد الإلكتروني');
      const row = [
        email.id,
        email.recipient,
        email.subject,
        email.status,
        email.error,
        email.timestamp
      ];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add email log to Excel:', error);
    }
  }

  /**
   * Add sync status to Excel
   */
  async addSyncStatus(sync) {
    if (!this.isInitialized) return;

    try {
      const sheet = this.workbook.getWorksheet('حالة المزامنة');
      const row = [
        sync.id,
        sync.sync_type,
        sync.status,
        sync.last_sync,
        sync.error,
        sync.timestamp
      ];
      sheet.addRow(row);
      await this.save();
    } catch (error) {
      console.error('❌ Failed to add sync status to Excel:', error);
    }
  }

  /**
   * Rebuild Excel from database - complete mirror
   */
  async rebuildFromDatabase(storage) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      console.log('🔄 Rebuilding Excel from database...');
      
      // Clear existing data (keep headers)
      const sheets = [
        'الإعدادات', 'الفئات', 'التذاكر', 'المصروفات', 
        'عمليات التحصيل', 'الملخص اليومي', 'سجل المراجعة',
        'إعادة تعيين التسلسل', 'سجل البريد الإلكتروني', 'حالة المزامنة'
      ];
      
      sheets.forEach(sheetName => {
        const sheet = this.workbook.getWorksheet(sheetName);
        if (sheet) {
          const rowCount = sheet.rowCount;
          if (rowCount > 1) {
            sheet.spliceRows(2, rowCount - 1); // Remove all rows except header
          }
        }
      });
      
      // Rebuild all data from database
      await this.rebuildSettings(storage);
      await this.rebuildCategories(storage);
      await this.rebuildTickets(storage);
      await this.rebuildExpenses(storage);
      await this.rebuildCollections(storage);
      // Note: Other tables (audit_log, daily_summary, etc.) would need similar methods
      
      console.log('✅ Excel rebuilt from database');
      return { success: true };
      
    } catch (error) {
      console.error('❌ Failed to rebuild Excel:', error);
      throw error;
    }
  }

  /**
   * Rebuild settings sheet from database
   */
  async rebuildSettings(storage) {
    const settings = storage.getAllSettings();
    const sheet = this.workbook.getWorksheet('الإعدادات');
    
    Object.entries(settings).forEach(([key, value]) => {
      const row = [key, value, new Date().toISOString()];
      sheet.addRow(row);
    });
  }

  /**
   * Rebuild categories sheet from database
   */
  async rebuildCategories(storage) {
    const categories = storage.getCategories(false); // Get all categories
    const sheet = this.workbook.getWorksheet('الفئات');
    
    categories.forEach(category => {
      const row = [
        category.id,
        category.name,
        category.price,
        category.active,
        category.serial_counter,
        category.created_at
      ];
      sheet.addRow(row);
    });
  }

  /**
   * Rebuild tickets sheet from database
   */
  async rebuildTickets(storage) {
    const tickets = storage.getTickets('2000-01-01', '2099-12-31');
    const sheet = this.workbook.getWorksheet('التذاكر');
    
    tickets.forEach(ticket => {
      const row = [
        ticket.id,
        ticket.serial_number,
        ticket.year,
        ticket.category_id,
        ticket.category_name,
        ticket.price,
        ticket.date,
        ticket.time,
        ticket.timestamp
      ];
      sheet.addRow(row);
    });
  }

  /**
   * Rebuild expenses sheet from database
   */
  async rebuildExpenses(storage) {
    const expenses = storage.getExpenses('2000-01-01', '2099-12-31');
    const sheet = this.workbook.getWorksheet('المصروفات');
    
    expenses.forEach(expense => {
      const row = [
        expense.id,
        expense.description,
        expense.amount,
        expense.date,
        expense.time,
        expense.timestamp
      ];
      sheet.addRow(row);
    });
  }

  /**
   * Rebuild collections sheet from database
   */
  async rebuildCollections(storage) {
    const collections = storage.getCollections('2000-01-01', '2099-12-31');
    const sheet = this.workbook.getWorksheet('عمليات التحصيل');
    
    collections.forEach(collection => {
      const row = [
        collection.id,
        collection.amount,
        collection.date,
        collection.time,
        collection.notes || '',
        collection.timestamp
      ];
      sheet.addRow(row);
    });
  }

  /**
   * Save workbook to file
   */
  async save() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.excelPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      await this.workbook.xlsx.writeFile(this.excelPath);
      console.log('💾 Excel file saved');
    } catch (error) {
      console.error('❌ Failed to save Excel file:', error);
      throw error;
    }
  }

  /**
   * Get Excel file status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      filePath: this.excelPath,
      exists: fs.existsSync(this.excelPath),
      size: fs.existsSync(this.excelPath) ? fs.statSync(this.excelPath).size : 0,
      lastModified: fs.existsSync(this.excelPath) ? fs.statSync(this.excelPath).mtime : null
    };
  }
}

module.exports = ExcelManager;