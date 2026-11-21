/**
 * HammamPOS - ExcelManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * A plain Excel copy of the data (hammampos.xlsx), for reading the numbers if the
 * app ever can't start. The database is the only source: every build rewrites the
 * whole file from it, so the file can never drift or lose old rows.
 *
 * - Changes (ticket, expense, ...) only schedule a build; builds are grouped (30 s).
 * - At startup the file is rebuilt only if the database is newer than it.
 * - The file is written to a temporary name first, then swapped in, so a crash or a
 *   power cut never leaves a half-written file.
 * - No settings, passwords or keys are written.
 */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const BUILD_DELAY_MS = 30 * 1000;
const STARTUP_DELAY_MS = 20 * 1000;

class ExcelManager {
  constructor(excelPath = null) {
    const appDataDir = path.join(process.env.APPDATA || process.env.HOME, 'HammamPOS');
    this.excelPath = excelPath || path.join(appDataDir, 'hammampos.xlsx');
    this.workbook = null;       // the last workbook built
    this.isInitialized = false;
    this.storage = null;
    this.money = null;
    this.timer = null;
    this.building = null;
    this.lastBuiltAt = null;
    this.lastError = null;
  }

  /**
   * @param {object} [storage] StorageManager (enables automatic builds)
   * @param {object} [money] MoneyService
   * @param {{ dbPath?: string }} [opts] database file, to skip the startup build when the file is up to date
   */
  async initialize(storage = null, money = null, opts = {}) {
    this.storage = storage;
    this.money = money;
    this.isInitialized = true;
    if (storage && this._isStale(opts.dbPath)) this._schedule(STARTUP_DELAY_MS);
    return { success: true };
  }

  _isStale(dbPath) {
    try {
      if (!fs.existsSync(this.excelPath)) return true;
      if (!dbPath || !fs.existsSync(dbPath)) return true;
      return fs.statSync(dbPath).mtimeMs > fs.statSync(this.excelPath).mtimeMs;
    } catch (_) {
      return true;
    }
  }

  _schedule(delay = BUILD_DELAY_MS) {
    if (!this.storage) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rebuildFromDatabase(this.storage, this.money).catch(() => {});
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  // Kept for the existing call sites: each one just asks for a new build.
  async addTicket() { this._schedule(); }
  async addExpense() { this._schedule(); }
  async addCollection() { this._schedule(); }
  async addFloatOperation() { this._schedule(); }

  /** Rebuild the whole file from the database now. */
  async rebuildFromDatabase(storage, money = null) {
    if (this.building) await this.building.catch(() => {});
    clearTimeout(this.timer);
    this.timer = null;
    this.building = this._build(storage || this.storage, money || this.money);
    try {
      await this.building;
      this.lastBuiltAt = new Date().toISOString();
      this.lastError = null;
      return { success: true };
    } catch (error) {
      this.lastError = error.message;
      console.error('Excel build failed:', error.message);
      throw error;
    } finally {
      this.building = null;
    }
  }

  async _build(storage, money) {
    if (!storage) throw new Error('no database');
    const rows = (sql) => {
      const r = storage.db.exec(sql);
      if (!r[0]) return [];
      const cols = r[0].columns;
      return r[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
    };
    const has = (table, col) => rows(`PRAGMA table_info(${table})`).some(c => c.name === col);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'HammamPOS';
    wb.created = new Date();

    const refundCols = has('tickets', 'refunded_at');
    const tickets = rows(`SELECT id, serial_number, year, category_name, price, date, time${refundCols ? ', refunded_at, refund_reason' : ''} FROM tickets ORDER BY id`);
    const expenses = rows('SELECT id, date, time, description, amount FROM expenses ORDER BY date, id');

    // Daily summary first: the sheet people open
    const days = new Map();
    const day = (d) => { if (!days.has(d)) days.set(d, { t: 0, s: 0, r: 0, e: 0 }); return days.get(d); };
    for (const t of tickets) {
      const x = day(t.date);
      if (t.refunded_at) x.r++; else { x.t++; x.s += Number(t.price) || 0; }
    }
    for (const e of expenses) day(e.date).e += Number(e.amount) || 0;
    const r2 = (n) => Math.round(n * 100) / 100;
    this._sheet(wb, 'الملخص اليومي', ['التاريخ', 'التذاكر', 'المبيعات', 'المسترجعة', 'المصروفات', 'الصافي'],
      [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([d, x]) => [d, x.t, r2(x.s), x.r, r2(x.e), r2(x.s - x.e)]),
      [12, 10, 12, 10, 12, 12]);

    this._sheet(wb, 'التذاكر', ['المعرف', 'الرقم', 'الفئة', 'السعر', 'التاريخ', 'الوقت', 'مسترجعة', 'سبب الاسترجاع'],
      tickets.map(t => [t.id, t.serial_number + '/' + t.year, t.category_name, t.price, t.date, t.time, t.refunded_at ? 'نعم' : '', t.refund_reason || '']),
      [8, 12, 16, 10, 12, 10, 10, 28]);

    this._sheet(wb, 'المصروفات', ['المعرف', 'التاريخ', 'الوقت', 'الوصف', 'المبلغ'],
      expenses.map(e => [e.id, e.date, e.time, e.description, e.amount]),
      [8, 12, 10, 34, 12]);

    const collections = rows('SELECT id, date, time, amount, notes FROM collections ORDER BY date, id');
    this._sheet(wb, 'عمليات التحصيل', ['المعرف', 'التاريخ', 'الوقت', 'المبلغ', 'ملاحظة'],
      collections.map(c => [c.id, c.date, c.time, c.amount, c.notes || '']),
      [8, 12, 10, 12, 34]);

    if (typeof storage.getFloatHistory === 'function') {
      const ops = storage.getFloatHistory().slice().reverse();
      this._sheet(wb, 'صندوق الصرف', ['المعرف', 'العملية', 'المبلغ', 'الرصيد بعدها', 'ملاحظة', 'التاريخ', 'الوقت'],
        ops.map(o => [o.id, o.operation === 'add' ? 'إضافة' : 'استرجاع', o.amount, o.balance_after, o.note || '', o.date, o.time]),
        [8, 10, 12, 14, 28, 12, 10]);
    }

    if (money && typeof money.exportData === 'function') this._moneySheets(wb, money.exportData());

    this.workbook = wb;
    await this._writeAtomic(wb);
  }

  _sheet(wb, name, headers, data, widths) {
    const sheet = wb.addWorksheet(name, { properties: { rightToLeft: true }, views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }] });
    sheet.columns = widths.map(w => ({ width: w }));
    sheet.addRow(headers).font = { bold: true };
    for (const r of data) sheet.addRow(r);
    return sheet;
  }

  _moneySheets(wb, data) {
    const who = (x) => (x === 'manager' ? 'المدير' : 'البائع');
    const src = (x) => (x === 'manager' ? 'من جيب المدير' : 'من الصندوق');
    const late = (x) => ({ pending: 'قيد المراجعة', accepted: 'مقبول', rejected: 'مرفوض' }[x] || '');
    const types = { in_person: 'تحصيل شخصي', bank: 'إيداع بنكي', transfer: 'تحويل', on_behalf: 'دفع نيابة عنك' };
    this._sheet(wb, 'مصاريف (النظام الجديد)',
      ['المعرف', 'التاريخ', 'الوصف', 'المورد', 'المبلغ الإجمالي', 'المدفوع', 'المتبقي', 'سجّله', 'وقت التسجيل'],
      data.expenses.map(e => {
        const paid = e.payments.filter(p => !p.late_status || p.late_status === 'accepted').reduce((a, p) => a + p.amount, 0);
        return [e.id, e.date, e.description, e.supplier || '', e.total, paid, Math.max(e.total - paid, 0), who(e.created_by), e.created_at];
      }),
      [8, 12, 28, 16, 14, 12, 12, 10, 20]);
    this._sheet(wb, 'دفعات المصاريف',
      ['المعرف', 'رقم المصروف', 'التاريخ', 'المبلغ', 'مصدر الدفع', 'إدخال متأخر', 'سجّله', 'وقت التسجيل'],
      data.payments.map(p => [p.id, p.expense_id, p.date, p.amount, src(p.source), late(p.late_status), who(p.created_by), p.created_at]),
      [8, 12, 12, 12, 16, 14, 10, 20]);
    this._sheet(wb, 'تحصيل (النظام الجديد)',
      ['المعرف', 'النوع', 'المبلغ', 'المتوقع', 'المعدود', 'الفرق', 'تسديد للمدير', 'ربح', 'المرجع', 'المستلم', 'ملاحظة', 'سجّلها', 'الحالة', 'وقت التسجيل'],
      data.collections.map(c => [c.id, types[c.type] || c.type, c.amount,
        c.expected == null ? '' : c.expected, c.counted == null ? '' : c.counted,
        c.expected == null || c.counted == null ? '' : Math.round((c.counted - c.expected) * 100) / 100,
        c.repayment_part, c.profit_part, c.reference || '', c.recipient || '', c.note || '', who(c.recorded_by),
        c.cancelled_at ? 'ملغاة: ' + (c.cancel_reason || '') : 'سارية', c.created_at]),
      [8, 16, 12, 12, 12, 10, 14, 10, 14, 14, 20, 10, 22, 20]);
    this._sheet(wb, 'ديون البائع', ['النوع', 'المبلغ', 'ملاحظة', 'الوقت'],
      [
        ...data.sellerDebts.map(d => ['نقص في العد', d.amount, d.note || '', d.created_at]),
        ...data.sellerDebtPayments.map(d => ['تسديد من البائع', -d.amount, d.note || '', d.created_at]),
        ...data.corrections.filter(c => c.type === 'late_entry_accepted').map(c => ['إدخال متأخر مقبول', -c.amount, c.note || '', c.created_at]),
        ...data.corrections.filter(c => c.type === 'unexplained_surplus').map(c => ['زيادة غير مبررة', c.amount, c.note || '', c.created_at])
      ],
      [20, 12, 30, 20]);
    this._sheet(wb, 'تذاكر مسترجعة', ['المعرف', 'التذكرة', 'الفئة', 'السعر', 'تاريخ البيع', 'وقت الاسترجاع', 'السبب'],
      data.refundedTickets.map(t => [t.id, t.serial_number + '/' + t.year, t.category_name, t.price, t.date, t.refunded_at, t.refund_reason || '']),
      [8, 12, 14, 10, 12, 20, 30]);
  }

  async _writeAtomic(wb) {
    const dir = path.dirname(this.excelPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.excelPath + '.tmp';
    await wb.xlsx.writeFile(tmp);
    try {
      fs.renameSync(tmp, this.excelPath);
    } catch (error) {
      // The file is open in Excel (Windows locks it): keep the new copy next to it.
      const side = this.excelPath.replace(/\.xlsx$/i, '') + ' (جديد).xlsx';
      try { fs.renameSync(tmp, side); } catch (_) { fs.rmSync(tmp, { force: true }); }
      throw new Error('الملف مفتوح في Excel. أغلقه، أو استعمل النسخة: ' + path.basename(side));
    }
  }

  getStatus() {
    const exists = fs.existsSync(this.excelPath);
    const st = exists ? fs.statSync(this.excelPath) : null;
    return {
      initialized: this.isInitialized,
      filePath: this.excelPath,
      exists,
      size: st ? st.size : 0,
      lastModified: st ? st.mtime : null,
      lastBuiltAt: this.lastBuiltAt,
      pending: !!this.timer || !!this.building,
      lastError: this.lastError
    };
  }
}

module.exports = ExcelManager;
