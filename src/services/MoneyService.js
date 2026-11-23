/**
 * MoneyService — the single owner of all money rules (drawer, expenses, payments,
 * collections, seller debts, corrections, notifications).
 *
 * Model (time-based, no per-day collection):
 *   Cash in hand      = sales cash in the drawer, computed from records created
 *                       AFTER the switch-over moment.
 *   Owed to suppliers = unpaid parts of expenses.
 *   Owed to manager   = parts paid by the manager, not yet repaid by collections.
 *   Owed by seller    = count shortages, not yet repaid.
 * The change float is outside all four numbers.
 *
 * Every balance is recalculated from the records on each call, so editing or
 * deleting any record always yields a consistent number.
 *
 * Times are stored as UTC 'YYYY-MM-DD HH:MM:SS', the same format SQLite's
 * CURRENT_TIMESTAMP uses for tickets.timestamp, so plain string comparison orders
 * them correctly.
 */

// Notification delivery (dashboard push / email) is intentionally OFF in this phase.
// Notifications are stored with delivery_status='pending' and shown in the admin
// history. Enable delivery during the new-Supabase / dashboard phase by setting
// this to true and implementing _deliverNotification().
const NOTIFICATION_DELIVERY_ENABLED = false;

const NOTIFICATION_TYPES = ['seller_collection', 'refund', 'paid_by_manager', 'late_entry', 'expense'];

class MoneyService {
  /**
   * @param {StorageManager} storage
   * @param {{ now?: () => Date }} [options] now() is injectable for tests.
   */
  constructor(storage, options = {}) {
    this.storage = storage;
    this.db = storage.db;
    this.now = options.now || (() => new Date());
    this.ensureSchema();
  }

  // ── Time ────────────────────────────────────────────────────────────────
  /** Current time as UTC 'YYYY-MM-DD HH:MM:SS'. */
  nowStamp() {
    return MoneyService.toStamp(this.now());
  }

  static toStamp(date) {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }

  // ── Schema ──────────────────────────────────────────────────────────────
  ensureSchema() {
    const run = (sql) => this.db.run(sql);

    run(`CREATE TABLE IF NOT EXISTS money_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    // What was spent. `date` = the day the expense happened (cost reports).
    run(`CREATE TABLE IF NOT EXISTS money_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      supplier TEXT,
      total REAL NOT NULL,
      legacy INTEGER NOT NULL DEFAULT 0,
      legacy_expense_id INTEGER,
      wood_purchase_id INTEGER,
      created_by TEXT NOT NULL DEFAULT 'seller',
      created_at TEXT NOT NULL
    )`);

    // How an expense was settled. source: 'drawer' | 'manager'.
    // late_status: NULL (normal) | 'pending' | 'accepted' | 'rejected' (Task 7).
    run(`CREATE TABLE IF NOT EXISTS expense_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT NOT NULL,
      legacy INTEGER NOT NULL DEFAULT 0,
      late_status TEXT,
      created_by TEXT NOT NULL DEFAULT 'seller',
      created_at TEXT NOT NULL,
      FOREIGN KEY (expense_id) REFERENCES money_expenses(id)
    )`);

    // Money leaving the drawer to the manager.
    // type: 'in_person' | 'bank' | 'transfer' | 'on_behalf'
    run(`CREATE TABLE IF NOT EXISTS money_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      recipient TEXT,
      note TEXT,
      recorded_by TEXT NOT NULL,
      expected REAL,
      counted REAL,
      repayment_part REAL NOT NULL DEFAULT 0,
      profit_part REAL NOT NULL DEFAULT 0,
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL
    )`);

    run(`CREATE TABLE IF NOT EXISTS seller_debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`);

    run(`CREATE TABLE IF NOT EXISTS seller_debt_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`);

    // type: 'unexplained_surplus' | 'late_entry_accepted' | ...
    run(`CREATE TABLE IF NOT EXISTS money_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      collection_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL
    )`);

    run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivered_at TEXT,
      delivery_error TEXT,
      created_at TEXT NOT NULL
    )`);

    // Refund columns on tickets (Task 4). Guarded: ADD COLUMN throws if present.
    try { run('ALTER TABLE tickets ADD COLUMN refunded_at TEXT'); } catch (_) {}
    try { run('ALTER TABLE tickets ADD COLUMN refund_reason TEXT'); } catch (_) {}

    // Same idea for collections: mirrored into the old `collections` table (admin
    // collections list, Excel, cloud) until those move to the new tables.
    try { run('ALTER TABLE money_collections ADD COLUMN mirror_collection_id INTEGER'); } catch (_) {}

    // Link to the row mirrored into the old `expenses` table. That mirror keeps the
    // daily summary, day details, Excel and cloud sync working until reports move
    // to the new tables (Task 9). It never affects the new balances.
    try { run('ALTER TABLE money_expenses ADD COLUMN mirror_expense_id INTEGER'); } catch (_) {}
    // Links an accepted-late-entry correction to its payment (so deleting the expense undoes it).
    try { run('ALTER TABLE money_corrections ADD COLUMN payment_id INTEGER'); } catch (_) {}

    run('CREATE INDEX IF NOT EXISTS idx_expense_payments_expense ON expense_payments(expense_id)');
    run('CREATE INDEX IF NOT EXISTS idx_money_collections_created ON money_collections(created_at)');
    run('CREATE INDEX IF NOT EXISTS idx_tickets_timestamp ON tickets(timestamp)');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  _scalar(sql, params = []) {
    const r = this.db.exec(sql, params);
    return r[0] && r[0].values[0] ? r[0].values[0][0] : null;
  }

  _rows(sql, params = []) {
    const r = this.db.exec(sql, params);
    if (!r[0]) return [];
    const cols = r[0].columns;
    return r[0].values.map(row => {
      const o = {};
      cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  }

  _getSetting(key) {
    return this._scalar('SELECT value FROM money_settings WHERE key = ?', [key]);
  }

  _setSetting(key, value) {
    this.db.run('INSERT OR REPLACE INTO money_settings (key, value) VALUES (?, ?)', [key, value]);
  }

  // ── Switch-over ─────────────────────────────────────────────────────────
  /** UTC stamp when the new system started, or null if not switched over yet. */
  getSwitchOverAt() {
    return this._getSetting('switch_over_at');
  }

  isSwitchedOver() {
    return !!this.getSwitchOverAt();
  }

  /**
   * Start the new money system now, with the drawer at 0. Meant to be done right
   * after a final collection with the old screen. Runs once.
   * Old expenses are copied into money_expenses / expense_payments (legacy=1) so
   * cost reports keep them; legacy records never affect the four balances.
   */
  switchOver() {
    if (this.isSwitchedOver()) {
      return { success: false, error: 'تم تفعيل نظام المال الجديد مسبقاً' };
    }
    const at = this.nowStamp();
    let converted = 0;

    const old = this._rows(`SELECT id, description, amount, date, time, timestamp,
        COALESCE(paid, 1) AS paid, paid_date, COALESCE(payment_source, 'cash') AS payment_source
      FROM expenses ORDER BY id`);
    let carried = 0;
    let carriedAmount = 0;
    let carriedOwedToManager = 0;
    for (const e of old) {
      const createdAt = e.timestamp || at;
      const unpaid = Number(e.paid) !== 1;
      const outOfPocket = !unpaid && e.payment_source === 'out_of_pocket';
      // Carried into the new system (legacy = 0), because they are still owed:
      //   unpaid       → open bill (owed to the supplier), payable normally
      //   out-of-pocket → paid by the manager (owed to the manager, repaid by collections)
      // Other paid ones stay legacy records (cost reports only, no effect on balances).
      const carry = unpaid || outOfPocket;
      this.db.run(`INSERT INTO money_expenses
          (date, description, total, legacy, legacy_expense_id, mirror_expense_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.date, e.description, e.amount, carry ? 0 : 1, e.id, carry ? e.id : null,
         carry ? 'carried' : 'legacy', createdAt]);
      const expenseId = this._scalar('SELECT last_insert_rowid()');
      if (unpaid) {
        carried++;
        carriedAmount += Number(e.amount) || 0;
      } else {
        this.db.run(`INSERT INTO expense_payments
            (expense_id, date, amount, source, legacy, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [expenseId, e.paid_date || e.date, e.amount,
           outOfPocket ? 'manager' : 'drawer', outOfPocket ? 0 : 1,
           outOfPocket ? 'carried' : 'legacy', createdAt]);
        if (outOfPocket) {
          carriedOwedToManager += Number(e.amount) || 0;
        }
      }
      converted++;
    }

    // Unpaid wood deliveries had NO expense row in the old system; carry them over
    // as open bills too (linked to the wood row; no old-table row is added, so the
    // history before the switch-over is unchanged).
    let woodRows = [];
    try {
      woodRows = this._rows(`SELECT id, delivery_date, supplier_name, wood_type, total_amount, created_at
        FROM wood_purchases WHERE COALESCE(paid, 0) = 0 AND expense_id IS NULL`);
    } catch (error) {
      // Only "no such table" (very old installs) is acceptable here.
      if (!/no such table/i.test(error.message)) throw error;
    }
    for (const w of woodRows) {
      const label = `خشب - ${w.supplier_name || 'مورد'}${w.wood_type ? ' (' + w.wood_type + ')' : ''}`;
      this.db.run(`INSERT INTO money_expenses
          (date, description, supplier, total, legacy, wood_purchase_id, created_by, created_at)
        VALUES (?, ?, ?, ?, 0, ?, 'carried', ?)`,
        [w.delivery_date, label, w.supplier_name || null, w.total_amount, w.id, w.created_at || at]);
      carried++;
      carriedAmount += Number(w.total_amount) || 0;
    }

    this._setSetting('switch_over_at', at);
    this.storage.logAudit('SWITCH_OVER', 'money', null,
      `New money system started at ${at} UTC; ${converted} old expenses converted; ` +
      `${carried} unpaid bills carried over (${MoneyService.round(carriedAmount)} DH); ` +
      `owed to manager carried over ${MoneyService.round(carriedOwedToManager)} DH`);
    this.storage.save();
    return {
      success: true, switchOverAt: at, convertedExpenses: converted,
      carriedBills: carried, carriedAmount: MoneyService.round(carriedAmount),
      carriedOwedToManager: MoneyService.round(carriedOwedToManager)
    };
  }

  // ── Balances ────────────────────────────────────────────────────────────
  /**
   * The four numbers. Before the switch-over, cash in hand falls back to the old
   * calculation so the app keeps working unchanged until the manager switches.
   */
  getBalances() {
    if (!this.isSwitchedOver()) {
      return {
        switchedOver: false,
        switchOverAt: null,
        cashInHand: this.storage.getCashInHand(),
        owedToSuppliers: 0,
        owedToManager: 0,
        owedBySeller: 0
      };
    }
    const since = this.getSwitchOverAt();
    const n = (sql, p = []) => Number(this._scalar(sql, p)) || 0;

    // A refunded ticket's money left the drawer again, so it no longer counts.
    const sales = n('SELECT COALESCE(SUM(price), 0) FROM tickets WHERE timestamp >= ? AND refunded_at IS NULL', [since]);
    const drawerPayments = n(`SELECT COALESCE(SUM(amount), 0) FROM expense_payments
      WHERE legacy = 0 AND source = 'drawer' AND late_status IS NULL`);
    const collections = n(`SELECT COALESCE(SUM(amount), 0) FROM money_collections
      WHERE cancelled_at IS NULL`);

    const owedToSuppliers = n(`SELECT COALESCE(SUM(MAX(e.total - COALESCE(p.paid, 0), 0)), 0)
      FROM money_expenses e
      LEFT JOIN (SELECT expense_id, SUM(amount) AS paid FROM expense_payments
                 WHERE late_status IS NULL OR late_status = 'accepted'
                 GROUP BY expense_id) p ON p.expense_id = e.id
      WHERE e.legacy = 0`);

    const managerPaid = n(`SELECT COALESCE(SUM(amount), 0) FROM expense_payments
      WHERE legacy = 0 AND source = 'manager'`);
    const repaid = n(`SELECT COALESCE(SUM(repayment_part), 0) FROM money_collections
      WHERE cancelled_at IS NULL`);

    const sellerDebt = n('SELECT COALESCE(SUM(amount), 0) FROM seller_debts');
    const sellerRepaid = n('SELECT COALESCE(SUM(amount), 0) FROM seller_debt_payments');
    // A count shortage is cash that is NOT in the drawer (it became a debt of the
    // seller); an unexplained surplus is cash found in the drawer beyond the records.
    // Both make the drawer land exactly on 0 right after an in-person collection.
    const surplus = n("SELECT COALESCE(SUM(amount), 0) FROM money_corrections WHERE type = 'unexplained_surplus'");
    // An accepted late entry explains part of a count shortage: the debt shrinks, the drawer does not change.
    const lateApplied = n("SELECT COALESCE(SUM(amount), 0) FROM money_corrections WHERE type = 'late_entry_accepted'");

    return {
      switchedOver: true,
      switchOverAt: since,
      cashInHand: MoneyService.round(sales - drawerPayments - collections - sellerDebt + surplus),
      owedToSuppliers: MoneyService.round(owedToSuppliers),
      owedToManager: MoneyService.round(Math.max(managerPaid - repaid, 0)),
      owedBySeller: MoneyService.round(Math.max(sellerDebt - sellerRepaid - lateApplied, 0))
    };
  }

  // ── Dates ───────────────────────────────────────────────────────────────
  /** Today's local date 'YYYY-MM-DD' (the calendar day the seller sees). */
  todayLocal() {
    const d = this.now();
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  static isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  // ── Expenses ────────────────────────────────────────────────────────────
  /**
   * Record an expense and how it was paid.
   *   fromDrawer: amount paid from the drawer now; 0 ≤ fromDrawer ≤ min(cash, total).
   *   The rest (total − fromDrawer) is either:
   *     restAs = 'unpaid'  → owed to the supplier
   *     restAs = 'manager' → paid by the manager from his pocket (owed to manager)
   * No seller loans: the drawer can never pay more than it holds.
   * @returns {{success:boolean, expenseId?:number, mirrorExpenseId?:number, error?:string}}
   */
  recordExpense(opts = {}) {
    const v = this._validateExpense(opts);
    if (!v.ok) return { success: false, error: v.error };
    return this._writeExpense(v);
  }

  _validateExpense(opts) {
    if (!this.isSwitchedOver()) {
      return { ok: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    }
    const description = String(opts.description == null ? '' : opts.description).trim();
    const supplier = String(opts.supplier == null ? '' : opts.supplier).trim();
    const total = MoneyService.round(opts.total);
    const fromDrawer = MoneyService.round(opts.fromDrawer == null ? 0 : opts.fromDrawer);
    const date = opts.date ? String(opts.date).trim() : this.todayLocal();
    const createdBy = opts.createdBy === 'manager' ? 'manager' : 'seller';

    if (!description) return { ok: false, error: 'وصف المصروف مطلوب' };
    if (!(total > 0)) return { ok: false, error: 'المبلغ غير صالح' };
    if (!MoneyService.isDate(date)) return { ok: false, error: 'التاريخ غير صالح' };
    if (date > this.todayLocal()) return { ok: false, error: 'لا يمكن تسجيل مصروف بتاريخ مستقبلي' };
    if (!Number.isFinite(Number(opts.fromDrawer == null ? 0 : opts.fromDrawer)) || fromDrawer < 0) {
      return { ok: false, error: 'المبلغ المدفوع من الصندوق غير صالح' };
    }
    if (fromDrawer > total + 0.005) {
      return { ok: false, error: 'المبلغ المدفوع من الصندوق أكبر من المبلغ الإجمالي' };
    }
    const lateInfo = fromDrawer > 0 ? this._lateCheck(date, opts.paidBeforeVisit === true) : { late: false };
    const cash = this.getBalances().cashInHand;
    if (!lateInfo.late && fromDrawer > cash + 0.005) {
      return { ok: false, error: `لا يوجد في الصندوق إلا ${cash} درهم` };
    }
    const rest = MoneyService.round(total - fromDrawer);
    let restAs = null;
    if (rest > 0) {
      if (opts.restAs !== 'unpaid' && opts.restAs !== 'manager') {
        return { ok: false, error: 'حدد كيف دُفع الباقي: غير مدفوع أو دفعه المدير' };
      }
      restAs = opts.restAs;
    }
    return {
      ok: true, description, supplier, total, fromDrawer, rest, restAs, date, createdBy, late: lateInfo.late,
      woodPurchaseId: opts.woodPurchaseId || null
    };
  }

  _writeExpense(v) {
    const at = this.nowStamp();
    this.db.run(`INSERT INTO money_expenses
        (date, description, supplier, total, legacy, wood_purchase_id, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [v.date, v.description, v.supplier || null, v.total, v.woodPurchaseId, v.createdBy, at]);
    const expenseId = this._scalar('SELECT last_insert_rowid()');

    const addPayment = (amount, source, lateStatus = null) => this.db.run(`INSERT INTO expense_payments
        (expense_id, date, amount, source, legacy, late_status, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [expenseId, v.date, amount, source, lateStatus, v.createdBy, at]);
    if (v.fromDrawer > 0) addPayment(v.fromDrawer, 'drawer', v.late ? 'pending' : null);
    if (v.restAs === 'manager') addPayment(v.rest, 'manager');

    // Mirror into the old expenses table (cost on the expense day) for the existing
    // daily summary / day details / Excel / cloud. Display-only from now on.
    const settled = !v.late && (v.rest <= 0 || v.restAs === 'manager');
    const mirrorId = this.storage.addExpense(v.description, v.total, {
      date: v.date,
      paid: settled,
      paymentSource: v.fromDrawer > 0 ? 'cash' : 'out_of_pocket',
      paidDate: settled ? v.date : null
    });
    this.db.run('UPDATE money_expenses SET mirror_expense_id = ? WHERE id = ?', [mirrorId, expenseId]);

    this.storage.logAudit('CREATE', 'money_expenses', expenseId,
      `${v.description} - total ${v.total} - drawer ${v.fromDrawer}` +
      (v.rest > 0 ? ` - rest ${v.rest} ${v.restAs}` : '') + ` - day ${v.date}`);
    this.storage.save();

    if (v.restAs === 'manager') {
      this.notify('paid_by_manager', {
        expenseId, description: v.description, supplier: v.supplier || null,
        amount: v.rest, total: v.total, date: v.date, recordedBy: v.createdBy
      });
    }
    // New expense for the manager's phone (not when he recorded it himself; a late entry has its own event)
    if (!v.late && v.createdBy !== 'manager') {
      this.notify('expense', {
        expenseId, description: v.description, supplier: v.supplier || null, total: v.total,
        fromDrawer: v.fromDrawer, unpaid: v.restAs === 'manager' ? 0 : v.rest,
        paidByManager: v.restAs === 'manager' ? v.rest : 0, date: v.date
      });
    }
    if (v.late) {
      const last = this.getPeriodStart().last;
      this.notify('late_entry', {
        expenseId, description: v.description, supplier: v.supplier || null,
        amount: v.fromDrawer, date: v.date, visitAt: last ? last.created_at : null, recordedBy: v.createdBy
      });
    }
    return { success: true, expenseId, mirrorExpenseId: mirrorId, late: !!v.late };
  }

  /**
   * Wood purchase under the new rules. The wood details row is written by
   * ExpenseTemplateManager (as unpaid), then the expense + payments here.
   * @param {ExpenseTemplateManager} woodManager
   * @param {object} opts wood fields + fromDrawer + restAs
   */
  recordWoodPurchase(woodManager, opts = {}) {
    if (!this.isSwitchedOver()) return { success: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    // Validate the payment split against today's cash BEFORE writing anything.
    const cash = this.getBalances().cashInHand;
    const fromDrawer = MoneyService.round(opts.fromDrawer == null ? 0 : opts.fromDrawer);
    if (fromDrawer < 0) return { success: false, error: 'المبلغ المدفوع من الصندوق غير صالح' };
    const woodLate = fromDrawer > 0 && opts.deliveryDate && this._lateCheck(opts.deliveryDate, opts.paidBeforeVisit === true).late;
    if (!woodLate && fromDrawer > cash + 0.005) return { success: false, error: `لا يوجد في الصندوق إلا ${cash} درهم` };
    if (opts.deliveryDate && opts.deliveryDate > this.todayLocal()) {
      return { success: false, error: 'لا يمكن تسجيل مصروف بتاريخ مستقبلي' };
    }

    const wood = woodManager.recordWoodPurchase({ ...opts, paid: false });
    if (!wood.success) return wood;
    const row = this._rows('SELECT supplier_name, wood_type FROM wood_purchases WHERE id = ?', [wood.woodId])[0] || {};
    const label = `خشب - ${row.supplier_name || 'مورد'}${row.wood_type ? ' (' + row.wood_type + ')' : ''}`;

    const v = this._validateExpense({
      date: opts.deliveryDate, description: label, supplier: row.supplier_name,
      total: wood.totalAmount, fromDrawer, restAs: opts.restAs,
      createdBy: opts.createdBy, woodPurchaseId: wood.woodId, paidBeforeVisit: opts.paidBeforeVisit
    });
    if (!v.ok) {
      this.db.run('DELETE FROM wood_purchases WHERE id = ?', [wood.woodId]);
      this.storage.save();
      return { success: false, error: v.error };
    }
    const res = this._writeExpense(v);
    const settled = !v.late && (v.rest <= 0 || v.restAs === 'manager');
    this.db.run('UPDATE wood_purchases SET expense_id = ?, paid = ?, paid_date = ? WHERE id = ?',
      [res.mirrorExpenseId, settled ? 1 : 0, settled ? v.date : null, wood.woodId]);
    this.storage.save();
    return { success: true, woodId: wood.woodId, expenseId: res.expenseId,
             mirrorExpenseId: res.mirrorExpenseId, totalAmount: wood.totalAmount, late: !!res.late };
  }

  // ── Bills (expenses with an unpaid part) ────────────────────────────────
  /**
   * New-model expenses with what was paid and what remains.
   * status: 'unpaid' (nothing paid) | 'partial' | 'paid'.
   * @param {{openOnly?: boolean}} [opts] openOnly → only bills with something left.
   */
  getBills(opts = {}) {
    const rows = this._rows(`SELECT e.id, e.date, e.description, e.supplier, e.total,
        e.wood_purchase_id, e.mirror_expense_id, e.created_at,
        COALESCE(SUM(CASE WHEN p.source = 'drawer' AND (p.late_status IS NULL OR p.late_status = 'accepted') THEN p.amount END), 0) AS paid_drawer,
        COALESCE(SUM(CASE WHEN p.source = 'manager' THEN p.amount END), 0) AS paid_manager,
        COALESCE(SUM(CASE WHEN p.late_status = 'pending' THEN p.amount END), 0) AS pending_late
      FROM money_expenses e
      LEFT JOIN expense_payments p ON p.expense_id = e.id
        AND (p.late_status IS NULL OR p.late_status IN ('accepted', 'pending'))
      WHERE e.legacy = 0
      GROUP BY e.id
      ORDER BY e.date DESC, e.id DESC`);
    const bills = rows.map(r => {
      const paid = MoneyService.round(r.paid_drawer + r.paid_manager);
      const remaining = MoneyService.round(Math.max(r.total - paid, 0));
      return {
        ...r,
        paid_drawer: MoneyService.round(r.paid_drawer),
        paid_manager: MoneyService.round(r.paid_manager),
        paid,
        remaining,
        pending_late: MoneyService.round(r.pending_late),
        // What can still be paid now (a pending late entry already covers part of it).
        payable: MoneyService.round(Math.max(remaining - r.pending_late, 0)),
        status: remaining <= 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid')
      };
    });
    return opts.openOnly ? bills.filter(b => b.remaining > 0) : bills;
  }

  getBill(expenseId) {
    return this.getBills().find(b => b.id === Number(expenseId)) || null;
  }

  /**
   * Pay part or all of what remains on a bill, today.
   *   source 'drawer'  → amount ≤ min(cash in hand, remaining)   (seller or manager)
   *   source 'manager' → amount ≤ remaining; owed to manager grows (manager only)
   * @returns {{success:boolean, bill?:object, error?:string}}
   */
  payBill(expenseId, amount, source, opts = {}) {
    if (!this.isSwitchedOver()) return { success: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    const bill = this.getBill(expenseId);
    if (!bill) return { success: false, error: 'الفاتورة غير موجودة' };
    if (source !== 'drawer' && source !== 'manager') return { success: false, error: 'مصدر الدفع غير صالح' };
    const value = MoneyService.round(amount);
    if (!(value > 0)) return { success: false, error: 'المبلغ غير صالح' };
    if (bill.remaining <= 0) return { success: false, error: 'هذه الفاتورة مدفوعة بالكامل' };
    if (bill.payable <= 0) return { success: false, error: 'عليها إدخال متأخر ينتظر مراجعة المدير' };
    if (value > bill.payable + 0.005) {
      return { success: false, error: `المتبقي على هذه الفاتورة ${bill.payable} درهم فقط` };
    }
    if (source === 'drawer') {
      const cash = this.getBalances().cashInHand;
      if (value > cash + 0.005) return { success: false, error: `لا يوجد في الصندوق إلا ${cash} درهم` };
    }
    const createdBy = opts.createdBy === 'manager' || source === 'manager' ? 'manager' : 'seller';
    const today = this.todayLocal();
    this.db.run(`INSERT INTO expense_payments
        (expense_id, date, amount, source, legacy, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`, [bill.id, today, value, source, createdBy, this.nowStamp()]);

    const after = this.getBill(bill.id);
    if (after.remaining <= 0) {
      // Fully settled: mark the old-table mirror and the wood row as paid (display).
      if (bill.mirror_expense_id) {
        this.db.run('UPDATE expenses SET paid = 1, paid_date = ? WHERE id = ?', [today, bill.mirror_expense_id]);
      }
      if (bill.wood_purchase_id) {
        this.db.run('UPDATE wood_purchases SET paid = 1, paid_date = ? WHERE id = ?', [today, bill.wood_purchase_id]);
      }
    }
    this.storage.logAudit('PAY', 'money_expenses', bill.id,
      `${value} from ${source} — remaining ${after.remaining}`);
    this.storage.save();

    if (source === 'manager') {
      this.notify('paid_by_manager', {
        expenseId: bill.id, description: bill.description, supplier: bill.supplier || null,
        amount: value, total: bill.total, date: today, recordedBy: 'manager'
      });
    }
    return { success: true, bill: after };
  }

  // ── Collections (money leaving the drawer to the manager) ──────────────
  static get COLLECTION_TYPES() { return ['in_person', 'bank', 'transfer', 'on_behalf']; }
  static get COLLECTION_LABELS() {
    return { in_person: 'تحصيل حضوري', bank: 'إيداع بنكي', transfer: 'تحويل مالي', on_behalf: 'دفع لشخص نيابة عن المدير' };
  }

  /**
   * Split a collection amount: what is owed to the manager is repaid FIRST, the rest
   * is profit taken out. Uses the balance before this collection.
   */
  _repaymentSplit(amount) {
    const owed = this.getBalances().owedToManager;
    const repayment = MoneyService.round(Math.min(amount, Math.max(owed, 0)));
    return { repayment, profit: MoneyService.round(amount - repayment) };
  }

  /**
   * Money sent to the manager without him being there: bank deposit, money transfer,
   * or paid to someone on his behalf. Counts immediately (drawer goes down).
   *   recordedBy 'seller' → the manager is notified; 'manager' → a forgotten receipt.
   * @returns {{success:boolean, collection?:object, error?:string}}
   */
  recordRemoteCollection(opts = {}) {
    if (!this.isSwitchedOver()) return { success: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    const type = opts.type;
    if (!['bank', 'transfer', 'on_behalf'].includes(type)) return { success: false, error: 'نوع العملية غير صالح' };
    const amount = MoneyService.round(opts.amount);
    if (!(amount > 0)) return { success: false, error: 'المبلغ غير صالح' };
    const cash = this.getBalances().cashInHand;
    if (amount > cash + 0.005) return { success: false, error: `لا يوجد في الصندوق إلا ${cash} درهم` };
    const reference = String(opts.reference == null ? '' : opts.reference).trim();
    const recipient = String(opts.recipient == null ? '' : opts.recipient).trim();
    const note = String(opts.note == null ? '' : opts.note).trim();
    if (type === 'on_behalf' && !recipient) return { success: false, error: 'اسم المستلم مطلوب' };
    const recordedBy = opts.recordedBy === 'manager' ? 'manager' : 'seller';

    const { repayment, profit } = this._repaymentSplit(amount);
    const at = this.nowStamp();
    this.db.run(`INSERT INTO money_collections
        (type, amount, reference, recipient, note, recorded_by, repayment_part, profit_part, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, amount, reference || null, recipient || null, note || null, recordedBy, repayment, profit, at]);
    const id = this._scalar('SELECT last_insert_rowid()');

    // Mirror into the old collections table (admin list / Excel / cloud).
    const label = MoneyService.COLLECTION_LABELS[type];
    const mirrorNote = [label, reference && `مرجع ${reference}`, recipient && `إلى ${recipient}`, note]
      .filter(Boolean).join(' — ');
    const mirrorId = this.storage.collectMoney(amount, mirrorNote);
    this.db.run('UPDATE money_collections SET mirror_collection_id = ? WHERE id = ?', [mirrorId, id]);

    this.storage.logAudit('CREATE', 'money_collections', id,
      `${type} ${amount}dh by ${recordedBy} (repayment ${repayment}, profit ${profit})` + (reference ? ` ref ${reference}` : ''));
    this.storage.save();

    if (recordedBy === 'seller') {
      this.notify('seller_collection', {
        collectionId: id, type, label, amount, reference: reference || null,
        recipient: recipient || null, repayment, profit
      });
    }
    return { success: true, collection: this.getCollection(id), mirrorCollectionId: mirrorId };
  }

  getCollection(id) {
    return this._rows('SELECT * FROM money_collections WHERE id = ?', [id])[0] || null;
  }

  /** All new-system collections, newest first. opts.remoteOnly → bank/transfer/on_behalf. */
  getCollections(opts = {}) {
    const where = opts.remoteOnly ? "WHERE type <> 'in_person'" : '';
    return this._rows(`SELECT * FROM money_collections ${where} ORDER BY created_at DESC, id DESC`)
      .map(c => ({ ...c, label: MoneyService.COLLECTION_LABELS[c.type] || c.type }));
  }

  /** Removes what an in-person visit created besides the collection row itself. */
  _undoVisitSideEffects(collectionId) {
    this.db.run('DELETE FROM seller_debts WHERE collection_id = ?', [collectionId]);
    this.db.run('DELETE FROM money_corrections WHERE collection_id = ?', [collectionId]);
  }

  /**
   * Manager cancels a collection (e.g. a deposit that never arrived): the money is
   * back in the drawer, and its repayment part is owed to the manager again.
   * Cancelling an in-person visit also removes the shortage debt / surplus it created.
   */
  cancelCollection(id, reason) {
    const c = this.getCollection(id);
    if (!c) return { success: false, error: 'العملية غير موجودة' };
    if (c.cancelled_at) return { success: false, error: 'هذه العملية ملغاة مسبقاً' };
    const why = String(reason == null ? '' : reason).trim();
    if (!why) return { success: false, error: 'سبب الإلغاء مطلوب' };
    this.db.run('UPDATE money_collections SET cancelled_at = ?, cancel_reason = ? WHERE id = ?',
      [this.nowStamp(), why, id]);
    if (c.type === 'in_person') this._undoVisitSideEffects(c.id);
    // Remove the old-table mirror so the admin list / Excel rebuild no longer count it.
    if (c.mirror_collection_id) {
      try { this.storage.deleteCollection(c.mirror_collection_id); } catch (_) { /* already gone */ }
    }
    this.storage.logAudit('CANCEL', 'money_collections', id, `${c.type} ${c.amount}dh — ${why}`);
    this.storage.save();
    return { success: true, collection: this.getCollection(id) };
  }

  /**
   * Called after a row of the old `collections` table is deleted from the admin
   * collections list: the linked new-system collection is cancelled too.
   */
  onMirrorCollectionDeleted(oldCollectionId) {
    const rows = this._rows('SELECT id FROM money_collections WHERE mirror_collection_id = ? AND cancelled_at IS NULL',
      [oldCollectionId]);
    for (const r of rows) {
      this.db.run('UPDATE money_collections SET cancelled_at = ?, cancel_reason = ?, mirror_collection_id = NULL WHERE id = ?',
        [this.nowStamp(), 'حُذف من سجل تحصيل الأموال', r.id]);
      this._undoVisitSideEffects(r.id);
      this.storage.logAudit('CANCEL', 'money_collections', r.id, `deleted from collections list (old id ${oldCollectionId})`);
    }
    if (rows.length) this.storage.save();
    return rows.length;
  }

  /**
   * For the dashboard: the period since the last visit, and the latest visits, each
   * with what happened in its own period (sales and payments from the drawer between
   * the visit before it and itself). Short keys: this travels with every heartbeat.
   */
  getDashboardVisits(limit = 10) {
    if (!this.isSwitchedOver()) return null;
    const r = MoneyService.round;
    const switchOver = this.getSwitchOverAt();
    const one = (sql, p) => this._rows(sql, p)[0] || {};
    const between = (from, fromOp, to) => {
      const cond = `${fromOp} ?` + (to ? ' AND {c} <= ?' : '');
      const args = to ? [from, to] : [from];
      const t = one(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS s FROM tickets WHERE timestamp ${cond.replace('{c}', 'timestamp')}`, args);
      const p = one(`SELECT COALESCE(SUM(amount),0) AS p FROM expense_payments WHERE legacy = 0 AND source = 'drawer'
        AND late_status IS NULL AND created_at ${cond.replace('{c}', 'created_at')}`, args);
      return { n: t.n || 0, s: r(t.s), p: r(p.p) };
    };
    const rows = this._rows(`SELECT created_at, expected, counted FROM money_collections
      WHERE type = 'in_person' AND cancelled_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`, [limit + 1]);
    const visits = rows.slice(0, limit).map((v, i) => {
      const prev = rows[i + 1];
      const b = between(prev ? prev.created_at : switchOver, prev ? '>' : '>=', v.created_at);
      return { at: v.created_at, x: r(v.expected), c: r(v.counted), ...b };
    });
    const p = this.getPeriodSummary();
    const e = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM money_expenses
      WHERE created_at ${this.getPeriodStart().op} ?`, [p.periodStart]);
    return {
      period: {
        start: p.periodStart, visit: !!p.lastVisit,
        n: p.sales.count, s: p.sales.total, r: p.refunds.total,
        e: r(e.t), en: e.n || 0, p: p.payments.total, remote: p.remote.total, other: p.other, cash: p.expected
      },
      visits
    };
  }

  // ── In-person collection (the manager's visit) ─────────────────────────
  /** Start of the current period: the last in-person collection, or the switch-over. */
  getPeriodStart() {
    const last = this._rows(`SELECT id, amount, expected, counted, created_at FROM money_collections
      WHERE type = 'in_person' AND cancelled_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`)[0] || null;
    return {
      last,
      start: last ? last.created_at : this.getSwitchOverAt(),
      // After a visit the period starts strictly after it; the first period includes the switch-over second.
      op: last ? '>' : '>='
    };
  }

  /**
   * Everything that happened since the last in-person collection, ending in the cash
   * the app expects in the drawer. Each line is a record in the period; "other" only
   * appears when something outside those lines changed the cash (e.g. an undone refund).
   */
  getPeriodSummary() {
    if (!this.isSwitchedOver()) return { switchedOver: false };
    const { last, start, op } = this.getPeriodStart();
    const switchOver = this.getSwitchOverAt();
    const sel = (sql, p = []) => this._rows(sql, p);

    const soldRows = sel(`SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS total FROM tickets
      WHERE timestamp ${op} ?`, [start])[0];
    const refundRows = sel(`SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS total FROM tickets
      WHERE refunded_at IS NOT NULL AND refunded_at ${op} ? AND timestamp >= ?`, [start, switchOver])[0];
    const payments = sel(`SELECT p.id, p.amount, p.date, p.created_at, e.description, e.supplier
      FROM expense_payments p JOIN money_expenses e ON e.id = p.expense_id
      WHERE p.legacy = 0 AND p.source = 'drawer' AND p.late_status IS NULL AND p.created_at ${op} ?
      ORDER BY p.created_at, p.id`, [start]);
    const remote = sel(`SELECT * FROM money_collections
      WHERE type <> 'in_person' AND cancelled_at IS NULL AND created_at ${op} ?
      ORDER BY created_at, id`, [start]).map(c => ({ ...c, label: MoneyService.COLLECTION_LABELS[c.type] || c.type }));

    const sales = MoneyService.round(soldRows.total);
    const refunds = MoneyService.round(refundRows.total);
    const paymentsTotal = MoneyService.round(payments.reduce((a, p) => a + p.amount, 0));
    const remoteTotal = MoneyService.round(remote.reduce((a, c) => a + c.amount, 0));
    const expected = this.getBalances().cashInHand;
    const other = MoneyService.round(expected - (sales - refunds - paymentsTotal - remoteTotal));

    return {
      switchedOver: true,
      periodStart: start,
      lastVisit: last ? { id: last.id, at: last.created_at, counted: last.counted, expected: last.expected } : null,
      sales: { count: soldRows.n, total: sales },
      refunds: { count: refundRows.n, total: refunds },
      payments: { total: paymentsTotal, items: payments },
      remote: { total: remoteTotal, items: remote },
      other,
      expected,
      owedToManager: this.getBalances().owedToManager
    };
  }

  /**
   * The manager counts the sales cash and takes it. The drawer goes to 0:
   *   counted < expected → the difference becomes owed by the seller
   *   counted > expected → the difference is an unexplained surplus (needs
   *                        opts.surplusAcknowledged after the manager looked for a
   *                        forgotten entry)
   * What is owed to the manager is repaid first; the rest is profit.
   * @returns {{success:boolean, collection?:object, shortage?:number, surplus?:number,
   *            needsSurplusConfirmation?:boolean, error?:string}}
   */
  collectInPerson(opts = {}) {
    if (!this.isSwitchedOver()) return { success: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    const raw = opts.counted;
    if (raw === '' || raw == null || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      return { success: false, error: 'المبلغ المعدود غير صالح' };
    }
    const counted = MoneyService.round(raw);
    const expected = this.getBalances().cashInHand;
    if (expected <= 0 && counted <= 0) return { success: false, error: 'لا يوجد نقد للتحصيل' };
    const diff = MoneyService.round(counted - expected);
    const shortage = diff < 0 ? MoneyService.round(-diff) : 0;
    const surplus = diff > 0 ? diff : 0;
    if (surplus > 0 && !opts.surplusAcknowledged) {
      return { success: false, needsSurplusConfirmation: true, surplus,
        error: 'المبلغ المعدود أكثر من المتوقع. ابحث أولاً عن عملية منسية' };
    }
    const note = String(opts.note == null ? '' : opts.note).trim();
    const { repayment, profit } = this._repaymentSplit(counted);
    const at = this.nowStamp();

    this.db.run(`INSERT INTO money_collections
        (type, amount, note, recorded_by, expected, counted, repayment_part, profit_part, created_at)
      VALUES ('in_person', ?, ?, 'manager', ?, ?, ?, ?, ?)`,
      [counted, note || null, expected, counted, repayment, profit, at]);
    const id = this._scalar('SELECT last_insert_rowid()');

    if (shortage > 0) {
      this.db.run('INSERT INTO seller_debts (collection_id, amount, note, created_at) VALUES (?, ?, ?, ?)',
        [id, shortage, note || 'نقص عند العدّ', at]);
    }
    if (surplus > 0) {
      this.db.run('INSERT INTO money_corrections (type, amount, collection_id, note, created_at) VALUES (?, ?, ?, ?, ?)',
        ['unexplained_surplus', surplus, id, note || 'فائض غير مفسَّر عند العدّ', at]);
    }

    // Mirror into the old collections log (admin list / Excel / cloud).
    if (counted > 0) {
      const extra = shortage > 0 ? ` — نقص ${shortage}` : (surplus > 0 ? ` — فائض غير مفسَّر ${surplus}` : '');
      const mirrorId = this.storage.collectMoney(counted, ['تحصيل حضوري', note].filter(Boolean).join(' — ') + extra);
      this.db.run('UPDATE money_collections SET mirror_collection_id = ? WHERE id = ?', [mirrorId, id]);
    }

    this.storage.logAudit('CREATE', 'money_collections', id,
      `in_person counted ${counted} expected ${expected} (shortage ${shortage}, surplus ${surplus}; repayment ${repayment}, profit ${profit})`);
    this.storage.save();
    return { success: true, collection: this.getCollection(id), shortage, surplus, repayment, profit };
  }

  // ── Refunds ─────────────────────────────────────────────────────────────
  // ── Late entries ────────────────────────────────────────────────────────
  /**
   * Is a drawer payment on `date` a late entry? It is when it belongs to a period the
   * manager already closed with an in-person visit:
   *   - dated before the day of the last visit, or
   *   - dated the same day, and the seller says it was paid BEFORE the visit.
   * Expenses only carry a date, so the same-day case needs the seller's answer.
   */
  _lateCheck(date, paidBeforeVisit) {
    const last = this.getPeriodStart().last;
    if (!last || !date) return { late: false };
    const visitDay = this._localDateOf(MoneyService.stampToDate(last.created_at));
    if (date < visitDay) return { late: true, visitDay };
    if (date === visitDay && paidBeforeVisit === true) return { late: true, visitDay };
    return { late: false, visitDay };
  }

  /** Keeps the old-table mirror and the wood row in step with the bill's real state. */
  _syncBillMirror(billId) {
    const bill = this.getBill(billId);
    if (!bill) return;
    const settled = bill.remaining <= 0;
    const today = this.todayLocal();
    if (bill.mirror_expense_id) {
      this.db.run('UPDATE expenses SET paid = ?, paid_date = CASE WHEN ? = 1 THEN COALESCE(paid_date, ?) ELSE NULL END WHERE id = ?',
        [settled ? 1 : 0, settled ? 1 : 0, today, bill.mirror_expense_id]);
    }
    if (bill.wood_purchase_id) {
      this.db.run('UPDATE wood_purchases SET paid = ?, paid_date = CASE WHEN ? = 1 THEN COALESCE(paid_date, ?) ELSE NULL END WHERE id = ?',
        [settled ? 1 : 0, settled ? 1 : 0, today, bill.wood_purchase_id]);
    }
  }

  /** Late entries (pending first, then reviewed), newest first. */
  getLateEntries(opts = {}) {
    const where = opts.pendingOnly ? "WHERE p.late_status = 'pending'" : 'WHERE p.late_status IS NOT NULL';
    return this._rows(`SELECT p.id, p.expense_id, p.amount, p.date, p.late_status, p.created_by, p.created_at,
        e.description, e.supplier
      FROM expense_payments p JOIN money_expenses e ON e.id = p.expense_id
      ${where} ORDER BY (p.late_status = 'pending') DESC, p.created_at DESC, p.id DESC`);
  }

  /**
   * Accept: the payment counts as paid and what the seller owes drops by the same
   * amount (up to his debt). The drawer does not change (it was already counted).
   */
  acceptLateEntry(paymentId) {
    const p = this._rows('SELECT p.*, e.description FROM expense_payments p JOIN money_expenses e ON e.id = p.expense_id WHERE p.id = ?', [paymentId])[0];
    if (!p || !p.late_status) return { success: false, error: 'الإدخال غير موجود' };
    if (p.late_status !== 'pending') return { success: false, error: 'تمت مراجعة هذا الإدخال مسبقاً' };
    const owed = this.getBalances().owedBySeller;
    const applied = MoneyService.round(Math.min(p.amount, owed));
    const extra = MoneyService.round(p.amount - applied);
    this.db.run("UPDATE expense_payments SET late_status = 'accepted' WHERE id = ?", [p.id]);
    if (applied > 0) {
      const last = this.getPeriodStart().last;
      this.db.run('INSERT INTO money_corrections (type, amount, collection_id, note, created_at, payment_id) VALUES (?, ?, ?, ?, ?, ?)',
        ['late_entry_accepted', applied, last ? last.id : null, `إدخال متأخر مقبول: ${p.description}`, this.nowStamp(), p.id]);
    }
    this._syncBillMirror(p.expense_id);
    this.storage.logAudit('ACCEPT_LATE', 'expense_payments', p.id, `${p.amount}dh applied to seller debt: ${applied}, beyond debt: ${extra}`);
    this.storage.save();
    return { success: true, applied, extra, owedBySeller: this.getBalances().owedBySeller };
  }

  /** Reject: the payment does not count; the shortage stays on the seller. */
  rejectLateEntry(paymentId) {
    const p = this._rows('SELECT * FROM expense_payments WHERE id = ?', [paymentId])[0];
    if (!p || !p.late_status) return { success: false, error: 'الإدخال غير موجود' };
    if (p.late_status !== 'pending') return { success: false, error: 'تمت مراجعة هذا الإدخال مسبقاً' };
    this.db.run("UPDATE expense_payments SET late_status = 'rejected' WHERE id = ?", [p.id]);
    this._syncBillMirror(p.expense_id);
    this.storage.logAudit('REJECT_LATE', 'expense_payments', p.id, `${p.amount}dh`);
    this.storage.save();
    return { success: true, owedBySeller: this.getBalances().owedBySeller };
  }

  // ── Seller debts ────────────────────────────────────────────────────────
  /** What the seller owes, with its history (shortages, his repayments, accepted late entries). */
  getSellerDebts() {
    const b = this.getBalances();
    return {
      owed: b.owedBySeller,
      debts: this._rows('SELECT id, collection_id, amount, note, created_at FROM seller_debts ORDER BY created_at DESC, id DESC'),
      payments: this._rows('SELECT id, amount, note, created_at FROM seller_debt_payments ORDER BY created_at DESC, id DESC'),
      adjustments: this._rows("SELECT id, amount, note, created_at FROM money_corrections WHERE type = 'late_entry_accepted' ORDER BY created_at DESC, id DESC")
    };
  }

  /**
   * The seller paid the manager (part of) what he owes. The money goes to the manager
   * directly, so the drawer is not affected.
   */
  markSellerRepayment(amount, note) {
    if (!this.isSwitchedOver()) return { success: false, error: 'يجب تفعيل نظام المال الجديد أولاً' };
    const value = MoneyService.round(amount);
    if (!(value > 0)) return { success: false, error: 'المبلغ غير صالح' };
    const owed = this.getBalances().owedBySeller;
    if (owed <= 0) return { success: false, error: 'لا يوجد دين على البائع' };
    if (value > owed + 0.005) return { success: false, error: `المتبقي على البائع ${owed} درهم فقط` };
    this.db.run('INSERT INTO seller_debt_payments (amount, note, created_at) VALUES (?, ?, ?)',
      [value, String(note == null ? '' : note).trim() || null, this.nowStamp()]);
    this.storage.logAudit('CREATE', 'seller_debt_payments', null, `${value}dh repaid by the seller`);
    this.storage.save();
    return { success: true, amount: value, owedBySeller: this.getBalances().owedBySeller };
  }

  static get REFUND_WINDOW_MS() { return 2 * 60 * 60 * 1000; }

  static stampToDate(stamp) {
    return new Date(String(stamp).replace(' ', 'T') + 'Z');
  }

  _localDateOf(date) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * Can this ticket be refunded by the seller now?
   * Rules: new system active, sold after the switch-over, not refunded yet,
   * sold TODAY (local calendar day) and no more than 2 hours ago.
   * @returns {{refundable:boolean, refunded:boolean, reason?:string}}
   */
  getRefundEligibility(ticket) {
    if (!ticket) return { refundable: false, refunded: false, reason: 'التذكرة غير موجودة' };
    if (ticket.refunded_at) return { refundable: false, refunded: true, reason: 'تم استرجاع هذه التذكرة مسبقاً' };
    if (!this.isSwitchedOver()) return { refundable: false, refunded: false, reason: 'يجب تفعيل نظام المال الجديد أولاً' };
    if (!this.getRefundsEnabled()) return { refundable: false, refunded: false, reason: 'الاسترجاع غير مفعّل من طرف المدير' };
    if (!ticket.timestamp || ticket.timestamp < this.getSwitchOverAt()) {
      return { refundable: false, refunded: false, reason: 'تذكرة مباعة قبل تفعيل نظام المال الجديد' };
    }
    const soldAt = MoneyService.stampToDate(ticket.timestamp);
    const now = this.now();
    if (this._localDateOf(soldAt) !== this.todayLocal()) {
      return { refundable: false, refunded: false, reason: 'لا يمكن استرجاع تذكرة من يوم آخر' };
    }
    if (now - soldAt > MoneyService.REFUND_WINDOW_MS) {
      return { refundable: false, refunded: false, reason: 'مرت أكثر من ساعتين على بيع هذه التذكرة' };
    }
    return { refundable: true, refunded: false };
  }

  /** The manager's on/off switch for seller refunds (default OFF). */
  getRefundsEnabled() {
    return this._getSetting('refunds_enabled') === '1';
  }

  setRefundsEnabled(on) {
    const value = on ? '1' : '0';
    this._setSetting('refunds_enabled', value);
    this.storage.logAudit('SETTING', 'money_settings', null, 'refunds_enabled=' + value);
    this.storage.save();
    return { success: true, enabled: !!on };
  }

  _getTicket(ticketId) {
    return this._rows('SELECT * FROM tickets WHERE id = ?', [ticketId])[0] || null;
  }

  /**
   * Seller refunds a ticket: it stays on record marked refunded; its price leaves
   * the drawer; that day's income and zakat no longer include it. Manager notified.
   */
  refundTicket(ticketId, reason) {
    const why = String(reason == null ? '' : reason).trim();
    if (!why) return { success: false, error: 'سبب الاسترجاع مطلوب' };
    const ticket = this._getTicket(ticketId);
    const e = this.getRefundEligibility(ticket);
    if (!e.refundable) return { success: false, error: e.reason };
    const at = this.nowStamp();
    this.db.run('UPDATE tickets SET refunded_at = ?, refund_reason = ? WHERE id = ?', [at, why, ticket.id]);
    this.storage.logAudit('REFUND', 'tickets', ticket.id,
      `${ticket.category_name} - ${ticket.serial_number}/${ticket.year} - ${ticket.price}dh - ${why}`);
    this.storage.save();
    this.notify('refund', {
      ticketId: ticket.id, serial: `${ticket.serial_number}/${ticket.year}`,
      category: ticket.category_name, amount: ticket.price, reason: why, soldAt: ticket.timestamp
    });
    return { success: true, ticketId: ticket.id, amount: ticket.price };
  }

  /** Manager undoes a refund (ticket counts as sold again). */
  undoRefund(ticketId) {
    const ticket = this._getTicket(ticketId);
    if (!ticket) return { success: false, error: 'التذكرة غير موجودة' };
    if (!ticket.refunded_at) return { success: false, error: 'هذه التذكرة غير مسترجعة' };
    this.db.run('UPDATE tickets SET refunded_at = NULL, refund_reason = NULL WHERE id = ?', [ticket.id]);
    this.storage.logAudit('UNDO_REFUND', 'tickets', ticket.id,
      `${ticket.serial_number}/${ticket.year} - ${ticket.price}dh (was: ${ticket.refund_reason || ''})`);
    this.storage.save();
    return { success: true, ticketId: ticket.id, amount: ticket.price };
  }

  /** Refund state of every ticket sold on a date: { [ticketId]: {refundable, refunded, reason} } */
  getRefundStatusForDate(date) {
    const out = {};
    this._rows('SELECT * FROM tickets WHERE date = ?', [date])
      .forEach(t => { out[t.id] = this.getRefundEligibility(t); });
    return out;
  }

  /**
   * Called by StorageManager.clearAllData() (testing only): wipes all new-model
   * money records so balances start from 0 again. The switch-over time is kept.
   */
  clearMoneyData() {
    ['expense_payments', 'money_expenses', 'money_collections', 'seller_debt_payments',
     'seller_debts', 'money_corrections', 'notifications']
      .forEach(t => this.db.run(`DELETE FROM ${t}`));
  }

  // ── Manager: edit / delete / history (Task 8) ───────────────────────────
  // Every change keeps a before/after copy in audit_log. Balances are recalculated
  // from the records, so they stay consistent after any edit or delete.

  /** An expense with its payments, or null. */
  _expenseSnapshot(id) {
    const e = this._rows('SELECT * FROM money_expenses WHERE id = ?', [id])[0];
    if (!e) return null;
    e.payments = this._rows('SELECT * FROM expense_payments WHERE expense_id = ? ORDER BY id', [id]);
    return e;
  }

  /** The new-system expense linked to a row of the old expenses table (day details), or null. */
  getExpenseByMirror(oldExpenseId) {
    const r = this._rows('SELECT id FROM money_expenses WHERE mirror_expense_id = ?', [oldExpenseId])[0];
    return r ? this._expenseSnapshot(r.id) : null;
  }

  /** The new-system collection linked to a row of the old collections table, or null. */
  getCollectionByMirror(oldCollectionId) {
    return this._rows('SELECT * FROM money_collections WHERE mirror_collection_id = ?', [oldCollectionId])[0] || null;
  }

  /** True when a record created at `createdAt` belongs to a period already closed by an in-person visit. */
  _isInClosedPeriod(createdAt) {
    const last = this.getPeriodStart().last;
    return !!(last && createdAt && createdAt < last.created_at);
  }

  /** What deleting an expense would change. Nothing is modified. */
  previewDeleteExpense(id) {
    const e = this._expenseSnapshot(id);
    if (!e) return { success: false, error: 'المصروف غير موجود' };
    const b = this.getBalances();
    const counted = (p) => p.late_status == null || p.late_status === 'accepted';
    const drawerBack = e.payments.filter(p => p.source === 'drawer' && p.late_status == null && !p.legacy)
      .reduce((a, p) => a + p.amount, 0);
    const managerPart = e.payments.filter(p => p.source === 'manager' && !p.legacy).reduce((a, p) => a + p.amount, 0);
    const paid = e.payments.filter(counted).reduce((a, p) => a + p.amount, 0);
    const unpaid = e.legacy ? 0 : Math.max(e.total - paid, 0);
    const mgrPaidAll = Number(this._scalar("SELECT COALESCE(SUM(amount),0) FROM expense_payments WHERE legacy = 0 AND source = 'manager'")) || 0;
    const repaid = Number(this._scalar('SELECT COALESCE(SUM(repayment_part),0) FROM money_collections WHERE cancelled_at IS NULL')) || 0;
    const lateApplied = this._rows(`SELECT COALESCE(SUM(c.amount),0) AS t FROM money_corrections c
      JOIN expense_payments p ON p.id = c.payment_id WHERE p.expense_id = ? AND c.type = 'late_entry_accepted'`, [id])[0].t;
    const closed = e.payments.some(p => this._isInClosedPeriod(p.created_at)) || this._isInClosedPeriod(e.created_at);
    return {
      success: true, expense: e,
      cashBefore: b.cashInHand, cashAfter: MoneyService.round(b.cashInHand + drawerBack),
      owedToSuppliersBefore: b.owedToSuppliers, owedToSuppliersAfter: MoneyService.round(b.owedToSuppliers - unpaid),
      owedToManagerBefore: b.owedToManager,
      owedToManagerAfter: MoneyService.round(Math.max(mgrPaidAll - managerPart - repaid, 0)),
      owedBySellerBefore: b.owedBySeller, owedBySellerAfter: MoneyService.round(b.owedBySeller + lateApplied),
      closedPeriod: closed
    };
  }

  /** Manager deletes an expense and everything attached to it. */
  deleteExpense(id, by = 'manager') {
    const e = this._expenseSnapshot(id);
    if (!e) return { success: false, error: 'المصروف غير موجود' };
    const pids = e.payments.map(p => p.id);
    if (pids.length) {
      this.db.run(`DELETE FROM money_corrections WHERE payment_id IN (${pids.map(() => '?').join(',')})`, pids);
    }
    this.db.run('DELETE FROM expense_payments WHERE expense_id = ?', [id]);
    this.db.run('DELETE FROM money_expenses WHERE id = ?', [id]);
    if (e.mirror_expense_id) {
      try { this.storage.deleteExpense(e.mirror_expense_id); } catch (_) { /* already gone */ }
    }
    this.storage.logAudit('DELETE', 'money_expenses', id, JSON.stringify({ by, before: e, after: null }));
    this.storage.save();
    return { success: true, deleted: e };
  }

  /**
   * Manager edits an expense: description, supplier, total, date. The payments are
   * kept as they are, so the total can never go below what is already paid.
   */
  editExpense(id, fields = {}) {
    const e = this._expenseSnapshot(id);
    if (!e) return { success: false, error: 'المصروف غير موجود' };
    const description = fields.description == null ? e.description : String(fields.description).trim();
    const supplier = fields.supplier == null ? e.supplier : (String(fields.supplier).trim() || null);
    const total = fields.total == null ? e.total : MoneyService.round(fields.total);
    const date = fields.date == null ? e.date : String(fields.date).trim();
    if (!description) return { success: false, error: 'وصف المصروف مطلوب' };
    if (!(total > 0)) return { success: false, error: 'المبلغ غير صالح' };
    if (!MoneyService.isDate(date)) return { success: false, error: 'التاريخ غير صالح' };
    if (date > this.todayLocal()) return { success: false, error: 'لا يمكن وضع تاريخ مستقبلي' };
    const paid = e.payments.filter(p => p.late_status == null || p.late_status === 'accepted')
      .reduce((a, p) => a + p.amount, 0);
    const pending = e.payments.filter(p => p.late_status === 'pending').reduce((a, p) => a + p.amount, 0);
    if (total + 0.005 < paid + pending) {
      return { success: false, error: `المبلغ لا يمكن أن يقل عن ${MoneyService.round(paid + pending)} درهم (المدفوع حتى الآن)` };
    }
    this.db.run('UPDATE money_expenses SET description = ?, supplier = ?, total = ?, date = ? WHERE id = ?',
      [description, supplier, total, date, id]);
    if (e.mirror_expense_id) {
      this.db.run('UPDATE expenses SET description = ?, amount = ?, date = ? WHERE id = ?',
        [description, total, date, e.mirror_expense_id]);
    }
    this._syncBillMirror(id);
    const after = this._expenseSnapshot(id);
    this.storage.logAudit('EDIT', 'money_expenses', id, JSON.stringify({
      before: { description: e.description, supplier: e.supplier, total: e.total, date: e.date },
      after: { description, supplier, total, date },
      closedPeriod: this._isInClosedPeriod(e.created_at)
    }));
    this.storage.save();
    return { success: true, expense: after, closedPeriod: this._isInClosedPeriod(e.created_at) };
  }

  /**
   * Manager edits the descriptive fields of a collection (reference, recipient,
   * note). The amount never changes: cancel it and record a new one instead.
   */
  editCollection(id, fields = {}) {
    const c = this.getCollection(id);
    if (!c) return { success: false, error: 'العملية غير موجودة' };
    if (c.cancelled_at) return { success: false, error: 'العملية ملغاة' };
    const reference = fields.reference == null ? c.reference : (String(fields.reference).trim() || null);
    const recipient = fields.recipient == null ? c.recipient : (String(fields.recipient).trim() || null);
    const note = fields.note == null ? c.note : (String(fields.note).trim() || null);
    if (c.type === 'on_behalf' && !recipient) return { success: false, error: 'اسم المستلم مطلوب' };
    this.db.run('UPDATE money_collections SET reference = ?, recipient = ?, note = ? WHERE id = ?', [reference, recipient, note, id]);
    if (c.mirror_collection_id) {
      const label = MoneyService.COLLECTION_LABELS[c.type] || c.type;
      const mirrorNote = [label, reference && `مرجع ${reference}`, recipient && `إلى ${recipient}`, note].filter(Boolean).join(' — ');
      this.db.run('UPDATE collections SET notes = ? WHERE id = ?', [mirrorNote, c.mirror_collection_id]);
    }
    this.storage.logAudit('EDIT', 'money_collections', id, JSON.stringify({
      before: { reference: c.reference, recipient: c.recipient, note: c.note },
      after: { reference, recipient, note },
      closedPeriod: this._isInClosedPeriod(c.created_at)
    }));
    this.storage.save();
    return { success: true, collection: this.getCollection(id) };
  }

  /** What cancelling / deleting a collection would change. Nothing is modified. */
  previewCancelCollection(id) {
    const c = this.getCollection(id);
    if (!c) return { success: false, error: 'العملية غير موجودة' };
    const b = this.getBalances();
    let cashDelta = c.cancelled_at ? 0 : c.amount;
    let debtRemoved = 0;
    if (!c.cancelled_at && c.type === 'in_person') {
      debtRemoved = Number(this._scalar('SELECT COALESCE(SUM(amount),0) FROM seller_debts WHERE collection_id = ?', [id])) || 0;
      const surplus = Number(this._scalar("SELECT COALESCE(SUM(amount),0) FROM money_corrections WHERE collection_id = ? AND type = 'unexplained_surplus'", [id])) || 0;
      cashDelta += debtRemoved - surplus;
    }
    const managerPaidAll = Number(this._scalar("SELECT COALESCE(SUM(amount),0) FROM expense_payments WHERE legacy = 0 AND source = 'manager'")) || 0;
    const repaidAll = Number(this._scalar('SELECT COALESCE(SUM(repayment_part),0) FROM money_collections WHERE cancelled_at IS NULL')) || 0;
    const newRepaid = c.cancelled_at ? repaidAll : repaidAll - c.repayment_part;
    return {
      success: true, collection: c,
      cashBefore: b.cashInHand, cashAfter: MoneyService.round(b.cashInHand + cashDelta),
      owedToManagerBefore: b.owedToManager, owedToManagerAfter: MoneyService.round(Math.max(managerPaidAll - newRepaid, 0)),
      owedBySellerBefore: b.owedBySeller,
      owedBySellerAfter: MoneyService.round(Math.max(b.owedBySeller - debtRemoved, 0)),
      closedPeriod: this._isInClosedPeriod(c.created_at)
    };
  }

  /**
   * One day's money in plain numbers: income (net of refunds), refunds, the cost
   * of the day's expenses, and how that cost was paid (drawer / manager / still unpaid).
   */
  getDaySummary(date) {
    const n = (sql, p = []) => Number(this._scalar(sql, p)) || 0;
    const counted = "(late_status IS NULL OR late_status = 'accepted')";
    const sales = n('SELECT COALESCE(SUM(price),0) FROM tickets WHERE date = ? AND refunded_at IS NULL', [date]);
    const tickets = n('SELECT COUNT(*) FROM tickets WHERE date = ? AND refunded_at IS NULL', [date]);
    const refundCount = n('SELECT COUNT(*) FROM tickets WHERE date = ? AND refunded_at IS NOT NULL', [date]);
    const refundTotal = n('SELECT COALESCE(SUM(price),0) FROM tickets WHERE date = ? AND refunded_at IS NOT NULL', [date]);
    const cost = n('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE date = ?', [date]);
    const paidDrawer = n(`SELECT COALESCE(SUM(amount),0) FROM expense_payments
      WHERE date = ? AND legacy = 0 AND source = 'drawer' AND ${counted}`, [date]);
    const paidManager = n(`SELECT COALESCE(SUM(amount),0) FROM expense_payments
      WHERE date = ? AND legacy = 0 AND source = 'manager' AND ${counted}`, [date]);
    const unpaid = n(`SELECT COALESCE(SUM(MAX(e.total - COALESCE(p.paid,0), 0)),0) FROM money_expenses e
      LEFT JOIN (SELECT expense_id, SUM(amount) AS paid FROM expense_payments WHERE ${counted} GROUP BY expense_id) p
        ON p.expense_id = e.id
      WHERE e.date = ? AND e.legacy = 0`, [date]);
    return {
      date, switchedOver: this.isSwitchedOver(), sales, tickets,
      refunds: { count: refundCount, total: refundTotal },
      cost, paidDrawer: MoneyService.round(paidDrawer), paidManager: MoneyService.round(paidManager),
      unpaid: MoneyService.round(unpaid)
    };
  }

  /** Every new-system record, for Excel / backup rebuilds. */
  exportData() {
    const expenses = this._rows('SELECT * FROM money_expenses ORDER BY id');
    const payments = this._rows('SELECT * FROM expense_payments ORDER BY id');
    return {
      switchOverAt: this.getSwitchOverAt(),
      refundsEnabled: this.getRefundsEnabled(),
      expenses: expenses.map(e => ({ ...e, payments: payments.filter(p => p.expense_id === e.id) })),
      payments,
      collections: this._rows('SELECT * FROM money_collections ORDER BY id'),
      sellerDebts: this._rows('SELECT * FROM seller_debts ORDER BY id'),
      sellerDebtPayments: this._rows('SELECT * FROM seller_debt_payments ORDER BY id'),
      corrections: this._rows('SELECT * FROM money_corrections ORDER BY id'),
      refundedTickets: this._rows('SELECT id, serial_number, year, category_name, price, date, time, refunded_at, refund_reason FROM tickets WHERE refunded_at IS NOT NULL ORDER BY refunded_at'),
      balances: this.getBalances()
    };
  }

  /** Newest first. opts: { limit, entity } — money records only. */
  getHistory(opts = {}) {
    const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 1000) : 200;
    const entities = ['money_expenses', 'money_collections', 'expense_payments', 'seller_debt_payments', 'tickets', 'money_settings'];
    const marks = entities.map(() => '?').join(',');
    const rows = this._rows(`SELECT id, action, entity, entity_id, details, timestamp FROM audit_log
      WHERE entity IN (${marks}) AND action <> 'DELETE_TICKET'
        AND NOT (entity = 'tickets' AND action NOT IN ('REFUND', 'UNDO_REFUND'))
      ORDER BY id DESC LIMIT ?`, [...entities, limit]);
    return rows.map(r => {
      let parsed = null;
      try { parsed = r.details && r.details[0] === '{' ? JSON.parse(r.details) : null; } catch (_) { parsed = null; }
      return { ...r, parsed };
    });
  }

  /**
   * Called after a row of the old `expenses` table is deleted (day details delete).
   * Removes the linked new-model expense and its payments, so balances stay right.
   */
  onMirrorExpenseDeleted(oldExpenseId) {
    const ids = this._rows('SELECT id FROM money_expenses WHERE mirror_expense_id = ?', [oldExpenseId])
      .map(r => r.id);
    for (const id of ids) {
      // The old row is already deleted; clear the link so deleteExpense does not try again.
      this.db.run('UPDATE money_expenses SET mirror_expense_id = NULL WHERE id = ?', [id]);
      this.deleteExpense(id, 'manager');
    }
    return ids.length;
  }

  static round(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // ── Notifications ───────────────────────────────────────────────────────
  /**
   * Store a notification for the manager. Delivery is disabled in this phase:
   * the row stays 'pending' and nothing is sent anywhere.
   * @param {string} type one of NOTIFICATION_TYPES
   * @param {object} payload plain data (amount, reference, ...)
   */
  notify(type, payload = {}) {
    if (!NOTIFICATION_TYPES.includes(type)) {
      throw new Error('Unknown notification type: ' + type);
    }
    this.db.run(
      "INSERT INTO notifications (type, payload, delivery_status, created_at) VALUES (?, ?, 'pending', ?)",
      [type, JSON.stringify(payload || {}), this.nowStamp()]);
    const id = this._scalar('SELECT last_insert_rowid()');
    this.storage.save();
    if (NOTIFICATION_DELIVERY_ENABLED) {
      this._deliverNotification(id);
    }
    return id;
  }

  /**
   * Delivery hook — NOT active in this phase (see NOTIFICATION_DELIVERY_ENABLED).
   * To be implemented with the new Supabase dashboard: push the row, then set
   * delivery_status='delivered' and delivered_at (or 'failed' + delivery_error).
   */
  _deliverNotification(_id) {
    // Intentionally empty.
  }

  getNotifications(limit = 100) {
    return this._rows(
      'SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?', [limit])
      .map(n => ({ ...n, payload: n.payload ? JSON.parse(n.payload) : {} }));
  }
}

MoneyService.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
MoneyService.NOTIFICATION_DELIVERY_ENABLED = NOTIFICATION_DELIVERY_ENABLED;

module.exports = MoneyService;
