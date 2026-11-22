'use strict';
/**
 * Money system — Task 2: seller expense entry with the drawer split.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT, ExpenseTemplateManager } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

const NOW = '2026-11-15T10:00:00Z';

// Switched-over money service with `cash` DH of sales in the drawer.
async function setup(cash) {
  const s = await newStorage();
  const m = new MoneyService(s, { now: () => new Date(NOW) });
  m.switchOver();
  if (cash > 0) {
    const c = s.addCategory('ر', cash);
    s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
              VALUES (1, 2026, ?, 'ر', ?, '2026-11-15', '10:30:00', '2026-11-15 10:30:00')`, [c, cash]);
  }
  return { s, m };
}

const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];

test('Example A: 1,000 from drawer + 500 unpaid', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'خشب', total: 1500, fromDrawer: 1000, restAs: 'unpaid' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [0, 500, 0, 0]);
    // one event for the manager's phone: a new expense with its unpaid part
    const n = m.getNotifications();
    assert.equal(n.length, 1);
    assert.equal(n[0].type, 'expense');
    assert.equal(n[0].payload.total, 1500);
    assert.equal(n[0].payload.unpaid, 500);
    assert.equal(n[0].payload.fromDrawer, 1000);
  } finally { cleanup(s); }
});

test('Example B: 1,000 from drawer + 500 paid by the manager (notified)', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'إصلاح', supplier: 'سباك', total: 1500, fromDrawer: 1000, restAs: 'manager' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [0, 0, 500, 0]);
    const n = m.getNotifications();
    assert.equal(n.length, 2);
    const pm = n.find(x => x.type === 'paid_by_manager');
    assert.equal(pm.payload.amount, 500);
    assert.equal(pm.payload.total, 1500);
    assert.equal(pm.delivery_status, 'pending');
    const ex = n.find(x => x.type === 'expense');
    assert.equal(ex.payload.paidByManager, 500);
    assert.equal(ex.payload.unpaid, 0);
  } finally { cleanup(s); }
});

test('Example C: 0 from drawer + 1,500 unpaid (drawer untouched)', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'خشب', total: 1500, fromDrawer: 0, restAs: 'unpaid' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [1000, 1500, 0, 0]);
  } finally { cleanup(s); }
});

test('fully paid from the drawer needs no "rest" choice', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'مصباح', total: 50, fromDrawer: 50 });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [950, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('drawer cap: cannot pay more than the cash in hand, nor more than the total', async () => {
  const { s, m } = await setup(1000);
  try {
    let r = m.recordExpense({ description: 'x', total: 1500, fromDrawer: 1000.01, restAs: 'unpaid' });
    assert.equal(r.success, false);
    r = m.recordExpense({ description: 'x', total: 300, fromDrawer: 400 });
    assert.equal(r.success, false);
    r = m.recordExpense({ description: 'x', total: 300, fromDrawer: -1, restAs: 'unpaid' });
    assert.equal(r.success, false);
    // Nothing was written by the refused attempts.
    assert.equal(s.db.exec('SELECT COUNT(*) FROM money_expenses WHERE legacy = 0')[0].values[0][0], 0);
    assert.deepEqual(four(m.getBalances()), [1000, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('validation: rest needs a choice; no future date; description and amount required', async () => {
  const { s, m } = await setup(1000);
  try {
    assert.equal(m.recordExpense({ description: 'x', total: 1500, fromDrawer: 1000 }).success, false);
    assert.equal(m.recordExpense({ description: 'x', total: 100, fromDrawer: 0, restAs: 'unpaid', date: '2026-11-16' }).success, false);
    assert.equal(m.recordExpense({ description: '', total: 100, fromDrawer: 100 }).success, false);
    assert.equal(m.recordExpense({ description: 'x', total: 0, fromDrawer: 0 }).success, false);
    // A past date is allowed (yesterday's incident).
    assert.equal(m.recordExpense({ description: 'x', total: 100, fromDrawer: 100, date: '2026-11-14' }).success, true);
  } finally { cleanup(s); }
});

test('refused before the switch-over', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: () => new Date(NOW) });
    assert.equal(m.recordExpense({ description: 'x', total: 10, fromDrawer: 0, restAs: 'unpaid' }).success, false);
  } finally { cleanup(s); }
});

test('mirror row keeps the old reports working and never changes the new balances', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'خشب', total: 1500, fromDrawer: 1000, restAs: 'unpaid', date: '2026-11-14' });
    const mirror = s.getExpense(r.mirrorExpenseId);
    assert.equal(mirror.amount, 1500);     // cost on the expense day
    assert.equal(mirror.date, '2026-11-14');
    const day = s.getDailySummariesWithDetails(100000).find(d => d.date === '2026-11-14');
    assert.equal(day.expenses, 1500);
    assert.deepEqual(four(m.getBalances()), [0, 500, 0, 0]);

    // Deleting the old row (day-details delete) removes the new record too.
    s.deleteExpense(r.mirrorExpenseId);
    assert.equal(m.onMirrorExpenseDeleted(r.mirrorExpenseId), 1);
    assert.deepEqual(four(m.getBalances()), [1000, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('wood paid now from the drawer', async () => {
  const { s, m } = await setup(1000);
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('حسن', '', 'أوكاليبتوس', 2);
    const r = m.recordWoodPurchase(w, {
      sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_load',
      totalAmount: 600, deliveryDate: '2026-11-15', fromDrawer: 600
    });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [400, 0, 0, 0]);
    const wood = s.db.exec('SELECT paid, paid_date, expense_id FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0];
    assert.deepEqual(wood, [1, '2026-11-15', r.mirrorExpenseId]);
    const me = s.db.exec('SELECT supplier, wood_purchase_id FROM money_expenses WHERE id = ?', [r.expenseId])[0].values[0];
    assert.deepEqual(me, ['حسن', r.woodId]);
  } finally { cleanup(s); }
});

test('wood unpaid, and wood split drawer + unpaid', async () => {
  const { s, m } = await setup(1000);
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('حسن', '', 'أوكاليبتوس', 2);
    const base = { sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_kg', netWeight: 500, unitPrice: 2, deliveryDate: '2026-11-15' };
    let r = m.recordWoodPurchase(w, { ...base, fromDrawer: 0, restAs: 'unpaid' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.totalAmount, 1000);
    assert.deepEqual(four(m.getBalances()), [1000, 1000, 0, 0]);
    assert.equal(s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0][0], 0);

    r = m.recordWoodPurchase(w, { ...base, fromDrawer: 700, restAs: 'unpaid' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [300, 1300, 0, 0]);
  } finally { cleanup(s); }
});

test('wood refused when the drawer cannot pay: no wood row is left behind', async () => {
  const { s, m } = await setup(100);
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('حسن', '', 'أوكاليبتوس', 2);
    const before = s.db.exec('SELECT COUNT(*) FROM wood_purchases')[0].values[0][0];
    // Total 600 but the "rest" choice is missing -> refused after the wood row was built.
    const r = m.recordWoodPurchase(w, { sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_load', totalAmount: 600, deliveryDate: '2026-11-15', fromDrawer: 100 });
    assert.equal(r.success, false);
    assert.equal(s.db.exec('SELECT COUNT(*) FROM wood_purchases')[0].values[0][0], before);
    // Drawer over-pay refused up front.
    const r2 = m.recordWoodPurchase(w, { sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_load', totalAmount: 600, deliveryDate: '2026-11-15', fromDrawer: 200, restAs: 'unpaid' });
    assert.equal(r2.success, false);
    assert.deepEqual(four(m.getBalances()), [100, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('expense event: none when the manager records it himself', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'كهرباء', total: 300, fromDrawer: 300, createdBy: 'manager' });
    assert.equal(r.success, true, r.error);
    assert.equal(m.getNotifications().filter(x => x.type === 'expense').length, 0);
  } finally { cleanup(s); }
});
