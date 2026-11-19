'use strict';
/**
 * Money system — Task 7: seller debts, repayments, and late entries.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT, ExpenseTemplateManager } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];
const stamp = (iso) => iso.replace('T', ' ').slice(0, 19);
let serial = 1;

// Local-time clock so "the same day as the visit" means the same LOCAL day.
const L = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);
const day = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
};

async function setup() {
  const s = await newStorage();
  let t = L(2026, 11, 15, 6);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c = s.addCategory('ر', 1);
  return {
    s, m, c,
    at: (d) => { t = d; },
    sell(price, when) {
      const st = stamp(when.toISOString());
      s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
                VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`, [serial++, c, price, st.slice(0, 10), st.slice(11), st]);
    }
  };
}

// A visit on 15 Nov at 14:00 local with a 500 shortage (expected 5,000, counted 4,500).
async function withShortage() {
  const ctx = await setup();
  ctx.sell(5000, L(2026, 11, 15, 8));
  ctx.at(L(2026, 11, 15, 14));
  const r = ctx.m.collectInPerson({ counted: 4500 });
  assert.equal(r.shortage, 500);
  return ctx;
}

// ── Seller repayments ──────────────────────────────────────────────────────
test('seller repays part, then the rest; drawer is never affected', async () => {
  const { s, m } = await withShortage();
  try {
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
    let r = m.markSellerRepayment(200, 'دفعة أولى');
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 300]);
    r = m.markSellerRepayment(300);
    assert.equal(r.success, true);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
    const h = m.getSellerDebts();
    assert.equal(h.owed, 0);
    assert.equal(h.debts.length, 1);
    assert.deepEqual(h.payments.map(p => p.amount).sort(), [200, 300]);
  } finally { cleanup(s); }
});

test('repayment limits: positive, not more than owed, nothing to repay', async () => {
  const { s, m } = await withShortage();
  try {
    assert.equal(m.markSellerRepayment(0).success, false);
    assert.equal(m.markSellerRepayment(-5).success, false);
    assert.equal(m.markSellerRepayment('abc').success, false);
    assert.equal(m.markSellerRepayment(500.01).success, false);
    assert.equal(m.markSellerRepayment(500).success, true);
    const again = m.markSellerRepayment(1);
    assert.equal(again.success, false);
    assert.match(again.error, /لا يوجد دين/);
  } finally { cleanup(s); }
});

// ── Late entry detection ───────────────────────────────────────────────────
test('dated BEFORE the visit day: late entry — drawer untouched, bill pending, manager notified', async () => {
  const { s, m, c, at, sell } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    sell(1000, L(2026, 11, 16, 8));
    const before = m.getBalances().cashInHand;
    const r = m.recordExpense({ description: 'سباك', supplier: 'سي علي', total: 300, fromDrawer: 300, date: '2026-11-14' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.late, true);
    assert.equal(m.getBalances().cashInHand, before, 'drawer unchanged');
    const bill = m.getBill(r.expenseId);
    assert.equal(bill.pending_late, 300);
    assert.equal(bill.payable, 0);
    assert.equal(bill.paid, 0);
    assert.equal(s.getExpense(r.mirrorExpenseId).paid, 0, 'old-table mirror is not "paid" yet');
    const n = m.getNotifications()[0];
    assert.equal(n.type, 'late_entry');
    assert.equal(n.payload.amount, 300);
    assert.equal(m.getLateEntries({ pendingOnly: true }).length, 1);
    // The same bill cannot be paid a second time from the drawer while this is pending.
    assert.equal(m.payBill(r.expenseId, 100, 'drawer').success, false);
    assert.ok(c);
  } finally { cleanup(s); }
});

test('same day as the visit: only "paid before the visit" is late', async () => {
  const { s, m, at, sell } = await withShortage();
  try {
    at(L(2026, 11, 15, 16));
    sell(800, L(2026, 11, 15, 15));
    const cash0 = m.getBalances().cashInHand; // 800
    const after = m.recordExpense({ description: 'بعد الزيارة', total: 100, fromDrawer: 100, date: '2026-11-15' });
    assert.equal(after.late, false);
    assert.equal(m.getBalances().cashInHand, cash0 - 100);
    const before = m.recordExpense({ description: 'قبل الزيارة', total: 300, fromDrawer: 300, date: '2026-11-15', paidBeforeVisit: true });
    assert.equal(before.late, true);
    assert.equal(m.getBalances().cashInHand, cash0 - 100, 'late entry did not touch the drawer');
  } finally { cleanup(s); }
});

test('dated after the visit day, or no visit yet: normal payment', async () => {
  const { s, m, at, sell } = await withShortage();
  try {
    at(L(2026, 11, 17, 10));
    sell(500, L(2026, 11, 17, 9));
    assert.equal(m.recordExpense({ description: 'x', total: 50, fromDrawer: 50, date: '2026-11-16' }).late, false);
    assert.equal(m.recordExpense({ description: 'y', total: 50, fromDrawer: 50, date: '2026-11-17', paidBeforeVisit: true }).late, false);
  } finally { cleanup(s); }

  const ctx = await setup(); // never visited
  try {
    ctx.sell(500, L(2026, 11, 15, 7));
    ctx.at(L(2026, 11, 16, 9));
    const r = ctx.m.recordExpense({ description: 'z', total: 100, fromDrawer: 100, date: '2026-11-10', paidBeforeVisit: true });
    assert.equal(r.late, false);
    assert.equal(ctx.m.getBalances().cashInHand, 400);
  } finally { cleanup(ctx.s); }
});

test('late entry may exceed the cash in hand (it never uses the drawer)', async () => {
  const { s, m, at } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    assert.equal(m.getBalances().cashInHand, 0);
    const r = m.recordExpense({ description: 'x', total: 300, fromDrawer: 300, date: '2026-11-14' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.late, true);
  } finally { cleanup(s); }
});

test('late entry mixed with a manager-paid part: only the drawer part is pending', async () => {
  const { s, m, at } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    const r = m.recordExpense({ description: 'x', total: 500, fromDrawer: 300, restAs: 'manager', date: '2026-11-14' });
    assert.equal(r.late, true);
    const bill = m.getBill(r.expenseId);
    assert.equal(bill.paid_manager, 200);
    assert.equal(bill.pending_late, 300);
    assert.equal(bill.status, 'partial');
    assert.equal(m.getBalances().owedToManager, 200);
  } finally { cleanup(s); }
});

// ── Accept / reject ────────────────────────────────────────────────────────
test('accept: seller debt drops by the amount, bill is paid, drawer unchanged', async () => {
  const { s, m, at, sell } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    sell(1000, L(2026, 11, 16, 8));
    const r = m.recordExpense({ description: 'سباك', total: 300, fromDrawer: 300, date: '2026-11-14' });
    const cash = m.getBalances().cashInHand;
    const pid = m.getLateEntries({ pendingOnly: true })[0].id;
    const a = m.acceptLateEntry(pid);
    assert.equal(a.success, true, a.error);
    assert.equal(a.applied, 300);
    assert.equal(a.extra, 0);
    assert.deepEqual(four(m.getBalances()), [cash, 0, 0, 200]);
    const bill = m.getBill(r.expenseId);
    assert.equal(bill.status, 'paid');
    assert.equal(s.getExpense(r.mirrorExpenseId).paid, 1);
    assert.equal(m.getLateEntries({ pendingOnly: true }).length, 0);
    assert.equal(m.acceptLateEntry(pid).success, false); // only once
    assert.equal(m.rejectLateEntry(pid).success, false);
  } finally { cleanup(s); }
});

test('accept beyond the debt: only the debt is reduced, the rest is reported', async () => {
  const { s, m, at } = await withShortage();
  try {
    m.markSellerRepayment(400);       // debt now 100
    at(L(2026, 11, 16, 9));
    m.recordExpense({ description: 'x', total: 300, fromDrawer: 300, date: '2026-11-14' });
    const a = m.acceptLateEntry(m.getLateEntries({ pendingOnly: true })[0].id);
    assert.equal(a.applied, 100);
    assert.equal(a.extra, 200);
    assert.equal(m.getBalances().owedBySeller, 0);
  } finally { cleanup(s); }
});

test('reject: the payment does not count, the shortage stays on the seller', async () => {
  const { s, m, at } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    const r = m.recordExpense({ description: 'x', total: 300, fromDrawer: 300, date: '2026-11-14' });
    const pid = m.getLateEntries({ pendingOnly: true })[0].id;
    const x = m.rejectLateEntry(pid);
    assert.equal(x.success, true, x.error);
    assert.equal(m.getBalances().owedBySeller, 500);
    const bill = m.getBill(r.expenseId);
    assert.equal(bill.status, 'unpaid');
    assert.equal(bill.pending_late, 0);
    assert.equal(bill.payable, 300);
    assert.equal(s.getExpense(r.mirrorExpenseId).paid, 0);
    assert.equal(m.getBalances().owedToSuppliers, 300);
    // The bill can now be paid normally.
    assert.equal(m.getLateEntries().find(e => e.id === pid).late_status, 'rejected');
  } finally { cleanup(s); }
});

test('wood delivery dated before the visit is a late entry too', async () => {
  const { s, m, at } = await withShortage();
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('حسن', '', 'أوكاليبتوس', 2);
    at(L(2026, 11, 16, 9));
    const r = m.recordWoodPurchase(w, { sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_load',
      totalAmount: 600, deliveryDate: '2026-11-14', fromDrawer: 600 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.late, true);
    assert.equal(s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0][0], 0);
    const a = m.acceptLateEntry(m.getLateEntries({ pendingOnly: true })[0].id);
    assert.equal(s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0][0], 1);
    assert.equal(a.applied, 500);   // the whole 500 shortage is explained
    assert.equal(a.extra, 100);     // 100 more than he owed
    assert.equal(m.getBalances().owedBySeller, 0);
  } finally { cleanup(s); }
});

test('the next visit does not count a pending late entry, and an accepted one keeps the drawer right', async () => {
  const { s, m, at, sell } = await withShortage();
  try {
    at(L(2026, 11, 16, 9));
    sell(2000, L(2026, 11, 16, 8));
    m.recordExpense({ description: 'x', total: 300, fromDrawer: 300, date: '2026-11-14' });
    m.acceptLateEntry(m.getLateEntries({ pendingOnly: true })[0].id);
    at(L(2026, 11, 16, 12));
    const p = m.getPeriodSummary();
    assert.equal(p.expected, 2000);          // the accepted late entry is not in this period
    assert.equal(p.payments.total, 0);
    const r = m.collectInPerson({ counted: 2000 });
    assert.equal(r.shortage, 0);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 200]);
  } finally { cleanup(s); }
});
